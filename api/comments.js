let clientPromise;

async function getSanityClient() {
  if (!process.env.SANITY_PROJECT_ID || !process.env.SANITY_API_TOKEN) return null;
  if (!clientPromise) {
    const configuredApiVersion = process.env.SANITY_API_VERSION || '';
    const apiVersion = /^\d{4}-\d{2}-\d{2}$/.test(configuredApiVersion)
      ? configuredApiVersion
      : '2026-07-28';
    clientPromise = import('@sanity/client').then((mod) => {
      const createClient = mod.createClient || mod.default || mod;
      if (typeof createClient !== 'function') {
        throw new Error('Unable to load createClient from @sanity/client');
      }
      return createClient({
        projectId: process.env.SANITY_PROJECT_ID,
        dataset: process.env.SANITY_DATASET || 'production',
        apiVersion,
        useCdn: false,
        token: process.env.SANITY_API_TOKEN
      });
    });
  }
  return clientPromise;
}

function normaliseComment(input) {
  const name = String(input?.name || '').trim().slice(0, 24);
  const text = String(input?.text || '').trim().slice(0, 120);
  return name && text ? { name, text } : null;
}

module.exports = async function handler(request, response) {
  try {
    const client = await getSanityClient();
    if (!client) {
      return response.status(503).json({
        error: 'Sanity environment is not configured',
        required: ['SANITY_PROJECT_ID', 'SANITY_API_TOKEN']
      });
    }

    if (request.method === 'GET') {
      const comments = await client.fetch(
        '*[_type == "comment"] | order(createdAt asc)[0...100]{_id, name, text, createdAt}'
      );
      return response.status(200).json(comments.map((comment) => ({
        id: comment._id,
        name: comment.name,
        text: comment.text,
        created_at: comment.createdAt
      })));
    }

    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;

    if (request.method === 'POST') {
      const comment = normaliseComment(body);
      if (!comment) return response.status(400).json({ error: 'Name and message are required' });

      const created = await client.create({
        _type: 'comment',
        name: comment.name,
        text: comment.text,
        createdAt: new Date().toISOString()
      });
      return response.status(201).json({
        id: created._id,
        name: comment.name,
        text: comment.text,
        created_at: created.createdAt
      });
    }

    if (request.method === 'DELETE') {
      const deletePassword = String(body?.password || '');
      if (!process.env.ADMIN_DELETE_PASSWORD || deletePassword !== process.env.ADMIN_DELETE_PASSWORD) {
        return response.status(401).json({ error: 'Invalid admin password' });
      }
      const id = String(body?.id || '');
      if (!/^[-_a-zA-Z0-9]+$/.test(id)) return response.status(400).json({ error: 'Invalid comment id' });
      await client.delete(id);
      return response.status(204).end();
    }

    response.setHeader('Allow', 'GET, POST, DELETE');
    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Comments API error:', error);
    return response.status(500).json({ error: 'Request failed' });
  }
};
