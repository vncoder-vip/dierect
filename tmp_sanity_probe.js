const fs = require('fs');
const path = require('path');
const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
  const index = trimmed.indexOf('=');
  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  env[key] = value;
}
const projectId = env.SANITY_PROJECT_ID;
const token = env.SANITY_API_TOKEN;
const dataset = env.SANITY_DATASET || 'production';
const query = '*[_type == "comment"] | order(createdAt asc)[0...100]{_id, name, text, createdAt}';
const url = `https://${projectId}.api.sanity.io/v2024-03-19/data/query/${encodeURIComponent(dataset)}?query=${encodeURIComponent(query)}`;
fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
  .then(async (response) => {
    const text = await response.text();
    fs.writeFileSync(path.join(__dirname, 'tmp_sanity_probe_output.json'), JSON.stringify({ status: response.status, body: text }, null, 2));
  })
  .catch((error) => {
    fs.writeFileSync(path.join(__dirname, 'tmp_sanity_probe_output.json'), JSON.stringify({ error: String(error) }, null, 2));
  });
