const fs = require('fs');
const path = require('path');
const env = {};
for (const line of fs.readFileSync('.env','utf8').split(/\r?\n/)) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i === -1) continue;
  const key = line.slice(0, i).trim();
  const value = line.slice(i + 1).trim();
  env[key] = value;
}
const project = env.SANITY_PROJECT_ID;
const token = env.SANITY_API_TOKEN;
const dataset = env.SANITY_DATASET || 'production';
for (const version of ['2023-11-21', '2024-03-19', '2025-03-19', '2026-07-28']) {
  const url = `https://${project}.api.sanity.io/v${version}/data/query/${encodeURIComponent(dataset)}?query=${encodeURIComponent('count(*[_type == "comment"])')}`;
  console.log('TRY', version, url);
  fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (res) => {
      const text = await res.text();
      console.log('status', res.status);
      console.log(text.slice(0, 1000));
    })
    .catch((err) => {
      console.error('ERR', err.message);
    });
}
