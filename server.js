const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_SANITY_API_VERSION = '2026-07-28';
const DEFAULT_SANITY_MAX_COMMENTS_PER_PROJECT = 1000;

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

function parseEnvContent(content) {
  const parsed = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadEnvFile(envFilePath = path.join(ROOT, '.env')) {
  if (!fs.existsSync(envFilePath)) return {};
  const parsed = parseEnvContent(fs.readFileSync(envFilePath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
  return parsed;
}

loadEnvFile();

function getEnvValue(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function getEnvNumber(name, fallback) {
  const parsed = Number(getEnvValue(name, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    })
  : null;

function getConfiguredSanityStorages(env = process.env) {
  const storages = [];
  const primary = {
    id: 'primary',
    projectId: getEnvValue('SANITY_PROJECT_ID', ''),
    dataset: getEnvValue('SANITY_DATASET', 'production'),
    token: getEnvValue('SANITY_API_TOKEN', ''),
    apiVersion: getEnvValue('SANITY_API_VERSION', DEFAULT_SANITY_API_VERSION)
  };
  if (primary.projectId && primary.token) {
    storages.push(primary);
  }

  for (let index = 1; index <= 14; index += 1) {
    const projectId = env[`SANITY_PROJECT_ID${index}`] || '';
    const token = env[`SANITY_API_TOKEN${index}`] || '';
    if (!projectId || !token) continue;
    storages.push({
      id: String(index),
      projectId,
      dataset: env[`SANITY_DATASET${index}`] || getEnvValue('SANITY_DATASET', 'production'),
      token,
      apiVersion: getEnvValue('SANITY_API_VERSION', DEFAULT_SANITY_API_VERSION)
    });
  }

  return storages;
}

function getMaxCommentsPerStorage() {
  return Math.max(1, getEnvNumber('SANITY_MAX_COMMENTS_PER_PROJECT', DEFAULT_SANITY_MAX_COMMENTS_PER_PROJECT));
}

function buildSanityUrl(storage, endpoint) {
  return `https://${storage.projectId}.api.sanity.io/v${storage.apiVersion}${endpoint}`;
}

async function sanityRequest(storage, endpoint, options = {}) {
  const url = buildSanityUrl(storage, endpoint);
  const headers = {
    Authorization: `Bearer ${storage.token}`,
    'Content-Type': 'application/json'
  };
  const init = {
    method: options.method || 'GET',
    headers
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const error = new Error(`Sanity request failed with status ${response.status}`);
    error.statusCode = response.status;
    error.details = payload;
    throw error;
  }

  return payload;
}

async function getCommentCount(storage) {
  const query = 'count(*[_type == "comment"])';
  const encodedQuery = encodeURIComponent(query);
  const payload = await sanityRequest(storage, `/data/query/${encodeURIComponent(storage.dataset)}?query=${encodedQuery}`);
  return Number(payload?.result ?? 0);
}

async function getCommentsFromStorage(storage) {
  const query = '*[_type == "comment"] | order(createdAt asc)[0...100]{_id, name, text, createdAt}';
  const payload = await sanityRequest(storage, `/data/query/${encodeURIComponent(storage.dataset)}?query=${encodeURIComponent(query)}`);
  const comments = Array.isArray(payload?.result) ? payload.result : [];
  return comments.map((comment) => ({
    id: comment._id,
    name: comment.name,
    text: comment.text,
    created_at: comment.createdAt,
    storage_id: storage.id
  }));
}

async function createCommentInStorage(storage, comment) {
  const payload = {
    mutations: [{
      create: {
        _type: 'comment',
        name: comment.name,
        text: comment.text,
        createdAt: new Date().toISOString()
      }
    }]
  };
  const result = await sanityRequest(storage, `/data/mutate/${encodeURIComponent(storage.dataset)}?returnIds=true`, {
    method: 'POST',
    body: payload
  });
  const ids = Array.isArray(result?.result) ? result.result : [];
  return {
    id: ids[0]?._id || null,
    name: comment.name,
    text: comment.text,
    created_at: new Date().toISOString()
  };
}

async function persistCommentWithStorageManager(comment) {
  const storages = getConfiguredSanityStorages();
  if (!storages.length) {
    const error = new Error('No Sanity storage configured');
    error.statusCode = 503;
    throw error;
  }

  const maxComments = getMaxCommentsPerStorage();
  for (const storage of storages) {
    try {
      const count = await getCommentCount(storage);
      if (count >= maxComments) {
        continue;
      }
      return await createCommentInStorage(storage, comment);
    } catch (error) {
      console.warn(`Skipping Sanity storage ${storage.id}:`, error.message);
    }
  }

  const error = new Error('All configured Sanity storages are full or unavailable');
  error.statusCode = 507;
  throw error;
}

async function listCommentsFromStorageManager() {
  const storages = getConfiguredSanityStorages();
  const allComments = [];
  for (const storage of storages) {
    try {
      const comments = await getCommentsFromStorage(storage);
      allComments.push(...comments);
    } catch (error) {
      console.warn(`Unable to read from Sanity storage ${storage.id}:`, error.message);
    }
  }

  return allComments
    .sort((first, second) => new Date(second.created_at || 0) - new Date(first.created_at || 0))
    .slice(0, 100);
}

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
  if (pool) {
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

  const storages = getConfiguredSanityStorages();
  if (!storages.length) {
    return sendJson(response, 503, { error: 'No storage backend configured' });
  }

  if (request.method === 'GET') {
    const comments = await listCommentsFromStorageManager();
    return sendJson(response, 200, comments);
  }

  if (request.method === 'POST') {
    const comment = normaliseComment(await readJson(request));
    if (!comment) return sendJson(response, 400, { error: 'Name and message are required' });
    try {
      const created = await persistCommentWithStorageManager(comment);
      return sendJson(response, 201, created);
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { error: error.message });
    }
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

function createServer() {
  return http.createServer(async (request, response) => {
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
}

function startServer() {
  const server = createServer();
  ensureSchema()
    .then(() => server.listen(PORT, () => console.log(`Chuột Chat listening on port ${PORT}`)))
    .catch((error) => {
      console.error('Database initialisation failed:', error);
      process.exit(1);
    });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createServer,
  getConfiguredSanityStorages,
  getMaxCommentsPerStorage,
  loadEnvFile,
  parseEnvContent,
  normaliseComment,
  persistCommentWithStorageManager,
  listCommentsFromStorageManager
};
