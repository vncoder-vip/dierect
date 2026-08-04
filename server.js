const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_SANITY_API_VERSION = '2024-03-19';
const DEFAULT_SANITY_MAX_COMMENTS_PER_PROJECT = 1000;
const SANITY_API_VERSION_CANDIDATES = ['2024-03-19', '2023-11-21', '2025-03-19', '2026-07-28'];

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.ogg': 'video/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.webp': 'image/webp'
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
    process.env[key] = value;
  }
  return parsed;
}

loadEnvFile();

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function normalizeSanityApiVersion(apiVersion) {
  const value = String(apiVersion || '').trim();
  if (!value) return DEFAULT_SANITY_API_VERSION;
  return value.replace(/^v/i, '');
}

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

function buildSanityUrl(storage, endpoint, apiVersion) {
  const version = normalizeSanityApiVersion(apiVersion || storage.apiVersion || DEFAULT_SANITY_API_VERSION);
  return `https://${storage.projectId}.api.sanity.io/v${version}${endpoint}`;
}

async function sanityRequest(storage, endpoint, options = {}) {
  const candidates = [normalizeSanityApiVersion(storage.apiVersion || DEFAULT_SANITY_API_VERSION), ...SANITY_API_VERSION_CANDIDATES];
  const uniqueVersions = [...new Set(candidates.filter(Boolean))];
  let lastError = null;

  for (const version of uniqueVersions) {
    const url = buildSanityUrl(storage, endpoint, version);
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

    try {
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
        lastError = new Error(`Sanity request failed with status ${response.status} at ${url}`);
        lastError.statusCode = response.status;
        lastError.details = payload;
        continue;
      }

      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  const finalError = lastError || new Error('Sanity request failed');
  finalError.statusCode = finalError.statusCode || 502;
  throw finalError;
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
      media_type VARCHAR(16),
      media_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE comments
    ADD COLUMN IF NOT EXISTS media_type VARCHAR(16),
    ADD COLUMN IF NOT EXISTS media_url TEXT
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

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const totalBytes = chunks.reduce((sum, part) => sum + part.length, 0);
      if (totalBytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseJsonBody(rawBody) {
  try {
    return JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  }
}

function sanitizeFileName(name) {
  const cleanName = String(name || 'upload').replace(/[^a-zA-Z0-9._-]/g, '-');
  const safeName = cleanName.replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return safeName || 'upload';
}

function inferMediaTypeFromMime(mimeType, fileName = '') {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  const lowerName = String(fileName).toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(lowerName)) return 'image';
  if (/\.(mp4|webm|ogg|mov|m4v)$/i.test(lowerName)) return 'video';
  return '';
}

function parseMultipartFormData(rawBody, contentType) {
  const boundaryMatch = contentType.match(/boundary=(.+)$/i);
  if (!boundaryMatch) return null;

  const boundary = Buffer.from(`--${boundaryMatch[1]}`);
  const parts = [];
  let start = 0;

  while (true) {
    const boundaryIndex = rawBody.indexOf(boundary, start);
    if (boundaryIndex === -1) break;
    if (boundaryIndex !== 0) {
      start = boundaryIndex + boundary.length;
      continue;
    }

    const nextBoundaryIndex = rawBody.indexOf(boundary, boundary.length);
    if (nextBoundaryIndex === -1) break;

    const partBuffer = rawBody.subarray(boundary.length, nextBoundaryIndex);
    const separatorIndex = partBuffer.indexOf(Buffer.from('\r\n\r\n'));
    const headerBuffer = separatorIndex >= 0 ? partBuffer.subarray(0, separatorIndex) : Buffer.alloc(0);
    let bodyBuffer = separatorIndex >= 0 ? partBuffer.subarray(separatorIndex + 4) : partBuffer;
    if (bodyBuffer.length >= 2 && bodyBuffer[bodyBuffer.length - 2] === 13 && bodyBuffer[bodyBuffer.length - 1] === 10) {
      bodyBuffer = bodyBuffer.subarray(0, bodyBuffer.length - 2);
    }

    const headersText = headerBuffer.toString('utf8');
    const dispositionMatch = headersText.match(/name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (dispositionMatch) {
      const fieldName = dispositionMatch[1];
      const fileName = dispositionMatch[2] || '';
      const contentTypeHeader = headersText.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim() || '';
      parts.push({ fieldName, fileName, contentTypeHeader, bodyBuffer });
    }

    start = nextBoundaryIndex + boundary.length;
    if (rawBody.indexOf(boundary, start) === -1) break;
  }

  return parts;
}

function saveUploadedFile(fileName, contentTypeHeader, bodyBuffer) {
  const extension = path.extname(fileName || '');
  const safeBaseName = sanitizeFileName(fileName || `upload${extension || ''}`);
  const filePath = path.join(UPLOADS_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeBaseName}`);
  fs.writeFileSync(filePath, bodyBuffer);
  const publicUrl = `/uploads/${path.basename(filePath)}`;
  return { filePath, publicUrl, mediaType: inferMediaTypeFromMime(contentTypeHeader || '', fileName) };
}

function normaliseComment(input) {
  const name = String(input?.name || '').trim().slice(0, 24);
  const text = String(input?.text || '').trim().slice(0, 120);
  const mediaType = String(input?.media_type || '').trim().toLowerCase();
  const mediaUrl = String(input?.media_url || '').trim();
  if (!name || !text) return null;

  const safeMediaType = ['image', 'video'].includes(mediaType) ? mediaType : '';
  const safeMediaUrl = safeMediaType && mediaUrl ? mediaUrl : '';

  return { name, text, media_type: safeMediaType, media_url: safeMediaUrl };
}

async function handleComments(request, response) {
  if (pool) {
    if (request.method === 'GET') {
      const result = await pool.query(
        'SELECT id, name, text, media_type, media_url, created_at FROM comments ORDER BY created_at DESC LIMIT 100'
      );
      return sendJson(response, 200, result.rows.reverse());
    }

    if (request.method === 'POST') {
      const contentTypeHeader = request.headers['content-type'] || '';
      let payload = { name: '', text: '', media_type: '', media_url: '' };

      if (contentTypeHeader.includes('multipart/form-data')) {
        const rawBody = await readRequestBody(request);
        const parts = parseMultipartFormData(rawBody, contentTypeHeader);
        const fields = {};
        let uploadedFile = null;
        for (const part of parts || []) {
          if (part.fileName) {
            uploadedFile = saveUploadedFile(part.fileName, part.contentTypeHeader, part.bodyBuffer);
          } else {
            fields[part.fieldName] = part.bodyBuffer.toString('utf8');
          }
        }
        payload = {
          name: fields.name || '',
          text: fields.text || '',
          media_type: fields.media_type || uploadedFile?.mediaType || '',
          media_url: uploadedFile?.publicUrl || fields.media_url || ''
        };
      } else {
        const rawBody = await readRequestBody(request);
        payload = parseJsonBody(rawBody);
      }

      const comment = normaliseComment(payload);
      if (!comment) return sendJson(response, 400, { error: 'Name and message are required' });
      const result = await pool.query(
        'INSERT INTO comments (name, text, media_type, media_url) VALUES ($1, $2, $3, $4) RETURNING id, name, text, media_type, media_url, created_at',
        [comment.name, comment.text, comment.media_type || null, comment.media_url || null]
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
    const contentTypeHeader = request.headers['content-type'] || '';
    let payload = { name: '', text: '', media_type: '', media_url: '' };

    if (contentTypeHeader.includes('multipart/form-data')) {
      const rawBody = await readRequestBody(request);
      const parts = parseMultipartFormData(rawBody, contentTypeHeader);
      const fields = {};
      let uploadedFile = null;
      for (const part of parts || []) {
        if (part.fileName) {
          uploadedFile = saveUploadedFile(part.fileName, part.contentTypeHeader, part.bodyBuffer);
        } else {
          fields[part.fieldName] = part.bodyBuffer.toString('utf8');
        }
      }
      payload = {
        name: fields.name || '',
        text: fields.text || '',
        media_type: fields.media_type || uploadedFile?.mediaType || '',
        media_url: uploadedFile?.publicUrl || fields.media_url || ''
      };
    } else {
      const rawBody = await readRequestBody(request);
      payload = parseJsonBody(rawBody);
    }

    const comment = normaliseComment(payload);
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
