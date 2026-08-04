from pathlib import Path
import requests

env = {}
for line in Path('.env').read_text(encoding='utf-8').splitlines():
    if '=' in line and not line.strip().startswith('#'):
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip()

project = env.get('SANITY_PROJECT_ID', '')
token = env.get('SANITY_API_TOKEN', '')
dataset = env.get('SANITY_DATASET', 'production')
api_version = env.get('SANITY_API_VERSION', '2026-07-28')
query = 'count(*[_type == "comment"])'
for version in [api_version, api_version.replace('v','') if api_version.startswith('v') else f'v{api_version}']:
    url = f'https://{project}.api.sanity.io/{version}/data/query/{dataset}?query={requests.utils.quote(query)}'
    print('TRY', version, url)
    try:
        r = requests.get(url, headers={'Authorization': f'Bearer {token}'}, timeout=20)
        print('status', r.status_code)
        print(r.text[:2000])
    except Exception as exc:
        print('ERR', repr(exc))
    print('---')
