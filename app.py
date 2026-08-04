import os
import json
import urllib.parse as urlparse
from flask import Flask, request, jsonify, send_from_directory, abort
import datetime
import requests

app = Flask(__name__, static_folder='.', static_url_path='')

PORT = int(os.environ.get('PORT', 10000))
ROOT = os.path.abspath(os.path.dirname(__file__))
MAX_BODY_BYTES = 16 * 1024
DEFAULT_SANITY_API_VERSION = '2026-07-28'
DEFAULT_SANITY_MAX_COMMENTS_PER_PROJECT = 1000


def parse_env_file(env_path):
    if not os.path.exists(env_path):
        return {}
    parsed = {}
    with open(env_path, encoding='utf-8') as handle:
        for line in handle.read().splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith('#') or '=' not in stripped:
                continue
            key, value = stripped.split('=', 1)
            key = key.strip()
            value = value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            parsed[key] = value
    return parsed


def load_env():
    env_path = os.path.join(ROOT, '.env')
    for key, value in parse_env_file(env_path).items():
        os.environ.setdefault(key, value)


load_env()

# Optional Postgres setup
DATABASE_URL = os.environ.get('DATABASE_URL')
pool = None
if DATABASE_URL:
    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor
        from psycopg2 import pool as pgpool
        pool = pgpool.SimpleConnectionPool(1, 10, dsn=DATABASE_URL)
    except Exception:
        pool = None


def ensure_schema():
    if not pool:
        return
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute('''
            CREATE TABLE IF NOT EXISTS comments (
              id BIGSERIAL PRIMARY KEY,
              name VARCHAR(24) NOT NULL,
              text VARCHAR(120) NOT NULL,
              media_type VARCHAR(16),
              media_url TEXT,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            ''')
            cur.execute("ALTER TABLE comments ADD COLUMN IF NOT EXISTS media_type VARCHAR(16)")
            cur.execute("ALTER TABLE comments ADD COLUMN IF NOT EXISTS media_url TEXT")
            conn.commit()
    finally:
        pool.putconn(conn)


def normalise_comment(input_data):
    name = str((input_data.get('name') if isinstance(input_data, dict) else '') or '').strip()[:24]
    text = str((input_data.get('text') if isinstance(input_data, dict) else '') or '').strip()[:120]
    media_type = str((input_data.get('media_type') if isinstance(input_data, dict) else '') or '').strip().lower()
    media_url = str((input_data.get('media_url') if isinstance(input_data, dict) else '') or '').strip()
    if not name or not text:
        return None
    if media_type not in {'image', 'video'}:
        media_type = ''
    if not media_type:
        media_url = ''
    return {'name': name, 'text': text, 'media_type': media_type, 'media_url': media_url}


def get_env_value(name, fallback=''):
    return os.environ.get(name, fallback)


def get_env_number(name, fallback):
    try:
        value = int(get_env_value(name, fallback))
    except (TypeError, ValueError):
        value = fallback
    return value


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


def sanity_request(storage, endpoint, method='GET', json_body=None):
    url = f"https://{storage['projectId']}.api.sanity.io/v{storage['apiVersion']}{endpoint}"
    headers = {'Authorization': f"Bearer {storage['token']}", 'Content-Type': 'application/json'}
    response = requests.request(method, url, headers=headers, json=json_body, timeout=10)
    if not response.ok:
        raise RuntimeError(f'Sanity request failed with status {response.status_code}')
    try:
        return response.json()
    except ValueError:
        return {}


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
        'storage_id': storage['id']
    } for comment in comments]


def create_comment_in_storage(storage, comment):
    payload = {
        'mutations': [{
            'create': {
                '_type': 'comment',
                'name': comment['name'],
                'text': comment['text'],
                'createdAt': datetime.datetime.utcnow().isoformat()
            }
        }]
    }
    result = sanity_request(storage, f"/data/mutate/{urlparse.quote(storage['dataset'])}?returnIds=true", method='POST', json_body=payload)
    ids = result.get('result', [])
    return {
        'id': ids[0].get('_id') if ids else None,
        'name': comment['name'],
        'text': comment['text'],
        'created_at': payload['mutations'][0]['create']['createdAt']
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
            all_comments.extend(get_comments_from_storage(storage))
        except Exception as exc:
            print(f'Unable to read from Sanity storage {storage["id"]}: {exc}')
    return sorted(all_comments, key=lambda item: item.get('created_at') or '', reverse=True)[:100]


@app.route('/api/comments', methods=['GET', 'POST', 'DELETE'])
def comments():
    if pool:
        return comments_postgres()

    if not get_configured_sanity_storages():
        return jsonify({'error': 'No backend configured'}), 503
    return comments_sanity()


def comments_postgres():
    if request.method == 'GET':
        conn = pool.getconn()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute('SELECT id, name, text, media_type, media_url, created_at FROM comments ORDER BY created_at DESC LIMIT 100')
                rows = cur.fetchall()
            rows.reverse()
            return jsonify(rows), 200
        finally:
            pool.putconn(conn)

    data = request.get_data(as_text=True) or '{}'
    if len(data.encode('utf8')) > MAX_BODY_BYTES:
        return jsonify({'error': 'Payload too large'}), 413
    try:
        body = json.loads(data)
    except Exception:
        return jsonify({'error': 'Invalid JSON'}), 400

    if request.method == 'POST':
        comment = normalise_comment(body)
        if not comment:
            return jsonify({'error': 'Name and message are required'}), 400
        conn = pool.getconn()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    'INSERT INTO comments (name, text, media_type, media_url) VALUES (%s, %s, %s, %s) RETURNING id, name, text, media_type, media_url, created_at',
                    (comment['name'], comment['text'], comment.get('media_type') or None, comment.get('media_url') or None)
                )
                created = cur.fetchone()
                conn.commit()
            return jsonify(created), 201
        finally:
            pool.putconn(conn)

    if request.method == 'DELETE':
        return jsonify({'error': 'Not supported on Postgres backend'}), 405


def comments_sanity():
    if request.method == 'GET':
        return jsonify(list_comments_from_storage_manager()), 200

    data = request.get_data(as_text=True) or '{}'
    if len(data.encode('utf8')) > MAX_BODY_BYTES:
        return jsonify({'error': 'Payload too large'}), 413
    try:
        body = json.loads(data)
    except Exception:
        return jsonify({'error': 'Invalid JSON'}), 400

    if request.method == 'POST':
        comment = normalise_comment(body)
        if not comment:
            return jsonify({'error': 'Name and message are required'}), 400
        try:
            created = persist_comment_with_storage_manager(comment)
            return jsonify(created), 201
        except RuntimeError as exc:
            return jsonify({'error': str(exc)}), 507

    if request.method == 'DELETE':
        delete_password = str(body.get('password') or '') if isinstance(body, dict) else ''
        if not get_env_value('ADMIN_DELETE_PASSWORD') or delete_password != get_env_value('ADMIN_DELETE_PASSWORD'):
            return jsonify({'error': 'Invalid admin password'}), 401
        id_ = str(body.get('id') or '')
        if not id_:
            return jsonify({'error': 'Invalid comment id'}), 400
        return jsonify({'error': 'Delete not supported for storage manager'}), 405


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_static_file(path):
    if path == '':
        path = 'index.html'
    full = os.path.abspath(os.path.join(ROOT, path))
    if not full.startswith(ROOT):
        abort(403)
    if not os.path.exists(full) or not os.path.isfile(full):
        abort(404)
    return send_from_directory(ROOT, path)


if __name__ == '__main__':
    try:
        ensure_schema()
    except Exception as e:
        print('Schema init failed:', e)
    app.run(host='0.0.0.0', port=PORT)
