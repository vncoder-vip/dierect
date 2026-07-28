const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const MAX_BODY_BYTES = 16 * 1024;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    })
  : null;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(24) NOT NULL,
      text VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function normaliseComment(input) {
  const name = String(input?.name || '').trim().slice(0, 24);
  const text = String(input?.text || '').trim().slice(0, 120);
  if (!name || !text) return null;
  return { name, text };
}

async function handleComments(request, response) {
  if (!pool) return sendJson(response, 503, { error: 'Database is not configured' });

  if (request.method === 'GET') {
    const result = await pool.query(
      'SELECT id, name, text, created_at FROM comments ORDER BY created_at DESC LIMIT 100'
    );
    return sendJson(response, 200, result.rows.reverse());
  }

  if (request.method === 'POST') {
    const comment = normaliseComment(await readJson(request));
    if (!comment) return sendJson(response, 400, { error: 'Name and message are required' });
    const result = await pool.query(
      'INSERT INTO comments (name, text) VALUES ($1, $2) RETURNING id, name, text, created_at',
      [comment.name, comment.text]
    );
    return sendJson(response, 201, result.rows[0]);
  }

  response.setHeader('Allow', 'GET, POST');
  return sendJson(response, 405, { error: 'Method not allowed' });
}

function serveStatic(request, response, pathname) {
  const requestedPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(ROOT, decodeURIComponent(requestedPath));
  if (!filePath.startsWith(ROOT + path.sep)) {
    response.writeHead(403);
    return response.end('Forbidden');
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404);
      return response.end('Not found');
    }
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=86400',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/api/comments') {
      return await handleComments(request, response);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendJson(response, 405, { error: 'Method not allowed' });
    }
    return serveStatic(request, response, url.pathname);
  } catch (error) {
    console.error(error);
    return sendJson(response, error.statusCode || 500, { error: 'Request failed' });
  }
});

ensureSchema()
  .then(() => server.listen(PORT, () => console.log(`Chuột Chat listening on port ${PORT}`)))
  .catch((error) => {
    console.error('Database initialisation failed:', error);
    process.exit(1);
  });
