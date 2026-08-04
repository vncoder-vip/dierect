import os
import json
import datetime
import urllib.parse as urlparse
import urllib.request
from http.server import BaseHTTPRequestHandler

# ---- Configuration ----
MAX_BODY_BYTES = 16 * 1024
DEFAULT_SANITY_API_VERSION = '2024-03-19'
DEFAULT_SANITY_MAX_COMMENTS_PER_PROJECT = 1000
SANITY_API_VERSION_CANDIDATES = ['2024-03-19', '2023-11-21', '2025-03-19', '2026-07-28']


# ---- Environment helpers ----
def get_env_value(name, fallback=''):
    return os.environ.get(name, fallback)


def get_env_number(name, fallback):
    try:
        return int(get_env_value(name, fallback))
    except (TypeError, ValueError):
        return fallback


def get_configured_sanity_storages():
    storages = []
    primary = {
        'id': 'primary',
        'projectId': get_env_value('SANITY_PROJECT_ID', ''),
        'dataset': get_env_value('SANITY_DATASET', 'production'),
        'token': get_env_value('SANITY_API_TOKEN', ''),
        'apiVersion': get_env_value('SANITY_API_VERSION', DEFAULT_SANITY_API_VERSION)
    }
    if primary['projectId'] and primary['token']:
        storages.append(primary)

    for index in range(1, 15):
        project_id = get_env_value(f'SANITY_PROJECT_ID{index}', '')
        token = get_env_value(f'SANITY_API_TOKEN{index}', '')
        if not project_id or not token:
            continue
        storages.append({
            'id': str(index),
            'projectId': project_id,
            'dataset': get_env_value(f'SANITY_DATASET{index}', get_env_value('SANITY_DATASET', 'production')),
            'token': token,
            'apiVersion': get_env_value('SANITY_API_VERSION', DEFAULT_SANITY_API_VERSION)
        })
    return storages


def get_max_comments_per_storage():
    return max(1, get_env_number('SANITY_MAX_COMMENTS_PER_PROJECT', DEFAULT_SANITY_MAX_COMMENTS_PER_PROJECT))


def normalize_sanity_api_version(api_version):
    value = str(api_version or '').strip()
    if not value:
        return DEFAULT_SANITY_API_VERSION
    return value.lstrip('v')


# ---- Sanity API helpers (using urllib instead of requests) ----
def sanity_request(storage, endpoint, method='GET', json_body=None):
    versions = [normalize_sanity_api_version(storage.get('apiVersion') or DEFAULT_SANITY_API_VERSION)]
    versions.extend(SANITY_API_VERSION_CANDIDATES)
    versions = list(dict.fromkeys(v for v in versions if v))
    last_exc = None
    for version in versions:
        url = f"https://{storage['projectId']}.api.sanity.io/v{version}{endpoint}"
        headers = {'Authorization': f"Bearer {storage['token']}", 'Content-Type': 'application/json'}
        try:
            data = None
            if json_body is not None:
                data = json.dumps(json_body).encode('utf-8')
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=10) as response:
                body = response.read().decode('utf-8')
                try:
                    return json.loads(body)
                except (ValueError, json.JSONDecodeError):
                    return {}
        except Exception as exc:
            last_exc = exc
    if last_exc:
        raise last_exc
    raise RuntimeError('Sanity request failed')


def get_comment_count(storage):
    query = 'count(*[_type == "comment"])'
    result = sanity_request(storage, f"/data/query/{urlparse.quote(storage['dataset'])}?query={urlparse.quote(query)}")
    return int(result.get('result', 0) or 0)


def get_comments_from_storage(storage):
    groq = '*[_type == "comment"] | order(createdAt asc)[0...100]{_id, name, text, createdAt}'
    result = sanity_request(storage, f"/data/query/{urlparse.quote(storage['dataset'])}?query={urlparse.quote(groq)}")
    comments = result.get('result', [])
    return [{
        'id': comment.get('_id'),
        'name': comment.get('name'),
        'text': comment.get('text'),
        'created_at': comment.get('createdAt'),
        'storage_id': storage['id'],
        'storage_label': f"Sanity #{storage['id']}"
    } for comment in comments]


def create_comment_in_storage(storage, comment):
    payload = {'mutations': [{'create': {'_type': 'comment', 'name': comment['name'], 'text': comment['text'], 'createdAt': datetime.datetime.utcnow().isoformat()}}]}
    result = sanity_request(storage, f"/data/mutate/{urlparse.quote(storage['dataset'])}?returnIds=true", method='POST', json_body=payload)
    ids = result.get('result', [])
    created_at = payload['mutations'][0]['create']['createdAt']
    return {
        'id': ids[0].get('_id') if ids else None,
        'name': comment['name'],
        'text': comment['text'],
        'created_at': created_at,
        'storage_id': storage['id'],
        'storage_label': f"Sanity #{storage['id']} ({storage.get('projectId', 'unknown')})"
    }


def persist_comment_with_storage_manager(comment):
    storages = get_configured_sanity_storages()
    if not storages:
        raise RuntimeError('No Sanity storage configured')
    max_comments = get_max_comments_per_storage()
    for storage in storages:
        try:
            count = get_comment_count(storage)
            if count >= max_comments:
                continue
            return create_comment_in_storage(storage, comment)
        except Exception as exc:
            print(f'Skipping Sanity storage {storage["id"]}: {exc}')
    raise RuntimeError('All configured Sanity storages are full or unavailable')


def list_comments_from_storage_manager():
    all_comments = []
    for storage in get_configured_sanity_storages():
        try:
            comments = get_comments_from_storage(storage)
            all_comments.extend(comments)
        except Exception as exc:
            print(f'Unable to read from Sanity storage {storage["id"]}: {exc}')
    return sorted(all_comments, key=lambda item: item.get('created_at') or '', reverse=True)[:100]


# ---- Comment helpers ----
def normalise_comment(input_data):
    name = str((input_data.get('name') if isinstance(input_data, dict) else '') or '').strip()[:24]
    text = str((input_data.get('text') if isinstance(input_data, dict) else '') or '').strip()[:120]
    if not name or not text:
        return None
    return {'name': name, 'text': text}


def get_comments_from_configured_backends():
    storages = get_configured_sanity_storages()
    if storages:
        try:
            return list_comments_from_storage_manager()
        except Exception as exc:
            print(f'Unable to read comments from Sanity backend: {exc}')
            return []
    return []


def persist_comment_to_configured_backends(comment):
    if get_configured_sanity_storages():
        return persist_comment_with_storage_manager(comment)
    raise RuntimeError('No backend configured')


# ---- Vercel Serverless Function (native Python, no Flask) ----
class handler(BaseHTTPRequestHandler):
    def _send_json(self, status, data):
        body = json.dumps(data, default=str).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length > MAX_BODY_BYTES:
            return None, 'too_large'
        if content_length == 0:
            return {}, None
        raw = self.rfile.read(content_length)
        content_type = self.headers.get('Content-Type', '')
        if 'application/json' in content_type:
            try:
                return json.loads(raw.decode('utf-8')), None
            except (ValueError, json.JSONDecodeError):
                return None, 'invalid_json'
        # Fallback: try JSON anyway
        try:
            return json.loads(raw.decode('utf-8')), None
        except (ValueError, json.JSONDecodeError):
            return None, 'invalid_json'

    def do_GET(self):
        try:
            comments = get_comments_from_configured_backends()
            self._send_json(200, comments)
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self._send_json(500, {'error': 'Internal server error', 'detail': str(exc)})

    def do_POST(self):
        try:
            body, err = self._read_body()
            if err == 'too_large':
                self._send_json(413, {'error': 'Payload too large'})
                return
            if err == 'invalid_json':
                self._send_json(400, {'error': 'Invalid JSON'})
                return
            if body is None:
                self._send_json(400, {'error': 'Invalid JSON'})
                return
            comment = normalise_comment(body)
            if not comment:
                self._send_json(400, {'error': 'Name and message are required'})
                return
            if not get_configured_sanity_storages():
                self._send_json(503, {'error': 'No backend configured'})
                return
            try:
                created = persist_comment_to_configured_backends(comment)
                self._send_json(201, created)
            except RuntimeError as exc:
                self._send_json(507, {'error': str(exc)})
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self._send_json(500, {'error': 'Internal server error', 'detail': str(exc)})

    def do_DELETE(self):
        try:
            body, err = self._read_body()
            if body is None:
                body = {}
            delete_password = str(body.get('password') or '') if isinstance(body, dict) else ''
            if not get_env_value('ADMIN_DELETE_PASSWORD') or delete_password != get_env_value('ADMIN_DELETE_PASSWORD'):
                self._send_json(401, {'error': 'Invalid admin password'})
                return
            id_ = str(body.get('id') or '')
            if not id_:
                self._send_json(400, {'error': 'Invalid comment id'})
                return
            self._send_json(405, {'error': 'Delete not supported for storage manager'})
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self._send_json(500, {'error': 'Internal server error', 'detail': str(exc)})

    def log_message(self, format, *args):
        # Suppress default logging
        pass