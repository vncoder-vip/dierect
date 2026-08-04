import os, requests, urllib.parse, json, pathlib
content = pathlib.Path('.env').read_text(encoding='utf-8')
env = {}
for line in content.splitlines():
    line = line.strip()
    if '=' in line and not line.startswith('#'):
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip()
project = env.get('SANITY_PROJECT_ID', '')
token = env.get('SANITY_API_TOKEN', '')
dataset = env.get('SANITY_DATASET', 'production')
query = '*[_type == "comment"] | order(createdAt asc)[0...10]{_id, name, text, createdAt}'
url = f'https://{project}.api.sanity.io/v2024-03-19/data/query/{dataset}?query={urllib.parse.quote(query)}'
print('URL', url)
r = requests.get(url, headers={'Authorization': f'Bearer {token}'}, timeout=20)
print('STATUS', r.status_code)
print('BODY', r.text[:4000])
