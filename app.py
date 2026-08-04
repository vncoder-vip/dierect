import os
import json
import urllib.parse as urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Flask, request, jsonify, send_from_directory, abort
import datetime
import requests

app = Flask(__name__, static_folder='.', static_url_path='')

try:
    PORT = int(os.environ.get('PORT') or 10000)
except (TypeError, ValueError):
    PORT = 10000
ROOT = os.path.abspath(os.path.dirname(__file__))
UPLOADS_DIR = os.path.join(ROOT, 'uploads')
MAX_BODY_BYTES = 16 * 1024
DEFAULT_SANITY_API_VERSION = '2024-03-19'
DEFAULT_SANITY_MAX_COMMENTS_PER_PROJECT = 1000
SANITY_API_VERSION_CANDIDATES = ['2024-03-19', '2023-11-21', '2025-03-19', '2026-07-28']
DEFAULT_SANITY_TIMEOUT_SECONDS = 8


def parse_env_file(env_path):
    if not os.path.exists(env_path):
        return {}
    parsed = {}
    try:
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
    except OSError:
        return {}
    return parsed


def load_env():
    env_path = os.path.join(ROOT, '.env')
    for key, value in parse_env_file(env_path).items():
        os.environ[key] = value


load_env()

# Vercel's deployed filesystem is read-only. Keep local uploads when possible,
# but never fail the whole Flask import if the deployment directory is not
# writable; /tmp is the only writable location in a serverless function.
try:
    os.makedirs(UPLOADS_DIR, exist_ok=True)
except OSError:
    UPLOADS_DIR = '/tmp/uploads'
    try:
        os.makedirs(UPLOADS_DIR, exist_ok=True)
    except OSError:
        UPLOADS_DIR = None

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


def save_uploaded_media(uploaded_file):
    if not uploaded_file or not uploaded_file.filename:
        return None
    if not UPLOADS_DIR:
        return None
    filename = os.path.basename(uploaded_file.filename)
    safe_name = ''.join(ch if ch.isalnum() or ch in {'.', '-', '_'} else '-' for ch in filename)
    safe_name = safe_name.strip('-.') or 'upload'
    target_path = os.path.join(UPLOADS_DIR, f"{datetime.datetime.utcnow().strftime('%Y%m%d%H%M%S')}-{safe_name}")
    uploaded_file.save(target_path)
    rel_path = f"/uploads/{os.path.basename(target_path)}"
    media_type = 'image' if uploaded_file.mimetype and uploaded_file.mimetype.startswith('image/') else 'video' if uploaded_file.mimetype and uploaded_file.mimetype.startswith('video/') else ''
    return {'media_type': media_type, 'media_url': rel_path}


def normalize_sanity_api_version(api_version):
    value = str(api_version or '').strip()
    if not value:
        return DEFAULT_SANITY_API_VERSION
    return value.lstrip('v')


def get_env_value(name, fallback=''):
    value = os.environ.get(name)
    if value is None:
        return fallback
    value = str(value).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1].strip()
    return value or fallback


def get_env_number(name, fallback):
    try:
        value = int(get_env_value(name, fallback))
    except (TypeError, ValueError):
        value = fallback
    return value


def get_sanity_timeout_seconds():
    return max(1, min(15, get_env_number('SANITY_TIMEOUT_SECONDS', DEFAULT_SANITY_TIMEOUT_SECONDS)))


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
    versions = [normalize_sanity_api_version(storage.get('apiVersion') or DEFAULT_SANITY_API_VERSION)]
    versions.extend(SANITY_API_VERSION_CANDIDATES)
    versions = list(dict.fromkeys(v for v in versions if v))
    last_exc = None
    for version in versions:
        url = f"https://{storage['projectId']}.api.sanity.io/v{version}{endpoint}"
        headers = {'Authorization': f"Bearer {storage['token']}", 'Content-Type': 'application/json'}
        try:
            response = requests.request(
                method,
                url,
                headers=headers,
                json=json_body,
                timeout=(3, get_sanity_timeout_seconds())
            )
            if not response.ok:
                last_exc = RuntimeError(f'Sanity request failed with status {response.status_code} at {url}')
                if response.status_code != 404:
                    break
                continue
            try:
                return response.json()
            except ValueError:
                return {}
        except Exception as exc:
            last_exc = exc
    if last_exc:
        raise last_exc
    raise RuntimeError('Sanity request failed')


def get_comment_count(storage):
    query = 'count(*[_type == "comment"])'
    result = sanity_request(storage, f"/data/query/{urlparse.quote(storage['dataset'])}?query={urlparse.quote(query)}")
    return int(result.get('result', 0) or 0) if isinstance(result, dict) else 0


def get_comments_from_storage(storage):
    groq = '*[_type == "comment"] | order(createdAt asc)[0...100]{_id, name, text, createdAt}'
    result = sanity_request(storage, f"/data/query/{urlparse.quote(storage['dataset'])}?query={urlparse.quote(groq)}")
    comments = result.get('result', []) if isinstance(result, dict) else []
    if not isinstance(comments, list):
        return []
    return [{
        'id': comment.get('_id'),
        'name': comment.get('name'),
        'text': comment.get('text'),
        'created_at': comment.get('createdAt'),
        'storage_id': storage['id']
    } for comment in comments if isinstance(comment, dict)]


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
    ids = result.get('result', []) if isinstance(result, dict) else []
    if not isinstance(ids, list):
        ids = []
    created_at = payload['mutations'][0]['create']['createdAt']
    first_id = ids[0] if ids else None
    if isinstance(first_id, dict):
        first_id = first_id.get('_id')
    return {
        'id': first_id,
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
    storages = get_configured_sanity_storages()
    if not storages:
        return []

    max_workers = min(8, len(storages))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(get_comments_from_storage, storage): storage for storage in storages}
        for future in as_completed(futures):
            storage = futures[future]
            try:
                comments = future.result()
                for comment in comments:
                    comment['storage_id'] = storage['id']
                    comment['storage_label'] = f"Sanity #{storage['id']}"
                    all_comments.append(comment)
            except Exception as exc:
                print(f'Unable to read from Sanity storage {storage["id"]}: {exc}')
    return sorted(all_comments, key=lambda item: item.get('created_at') or '', reverse=True)[:100]


def get_comments_from_configured_backends():
    storages = get_configured_sanity_storages()
    if storages:
        try:
            return list_comments_from_storage_manager()
        except Exception as exc:
            print(f'Unable to read comments from Sanity backend: {exc}')
            return []

    if not pool:
        return []

    from psycopg2.extras import RealDictCursor
    conn = pool.getconn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute('SELECT id, name, text, media_type, media_url, created_at FROM comments ORDER BY created_at DESC LIMIT 100')
            rows = cur.fetchall()
        return rows
    finally:
        pool.putconn(conn)


def persist_comment_to_configured_backends(comment):
    if get_configured_sanity_storages():
        try:
            return persist_comment_with_storage_manager(comment)
        except Exception as exc:
            print(f'Unable to persist comment to Sanity backend: {exc}')

    if not pool:
        raise RuntimeError('No backend configured')

    from psycopg2.extras import RealDictCursor
    conn = pool.getconn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                'INSERT INTO comments (name, text, media_type, media_url) VALUES (%s, %s, %s, %s) RETURNING id, name, text, media_type, media_url, created_at',
                (comment['name'], comment['text'], comment.get('media_type') or None, comment.get('media_url') or None)
            )
            created = cur.fetchone()
            conn.commit()
        return created
    finally:
        pool.putconn(conn)


@app.route('/api/comments', methods=['GET', 'POST', 'DELETE'])
def comments():
    if not get_configured_sanity_storages():
        if pool:
            return comments_postgres()
        return jsonify({'error': 'No backend configured'}), 503
    return comments_sanity()


def comments_postgres():
    if request.method == 'GET':
        conn = pool.getconn()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute('SELECT id, name, text, media_type, media_url, created_at FROM comments ORDER BY created_at DESC LIMIT 100')
                rows = cur.fetchall()
            return jsonify(rows), 200
        finally:
            pool.putconn(conn)

    if request.method == 'POST':
        if request.content_type and 'multipart/form-data' in request.content_type:
            body = {
                'name': request.form.get('name', ''),
                'text': request.form.get('text', ''),
                'media_type': request.form.get('media_type', ''),
                'media_url': request.form.get('media_url', '')
            }
            uploaded = save_uploaded_media(request.files.get('media_file'))
            if uploaded:
                body['media_type'] = body.get('media_type') or uploaded['media_type']
                body['media_url'] = uploaded['media_url'] or body.get('media_url')
        else:
            data = request.get_data(as_text=True) or '{}'
            if len(data.encode('utf8')) > MAX_BODY_BYTES:
                return jsonify({'error': 'Payload too large'}), 413
            try:
                body = json.loads(data)
            except Exception:
                return jsonify({'error': 'Invalid JSON'}), 400

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
        return jsonify(get_comments_from_configured_backends()), 200

    if request.method == 'POST':
        if request.content_type and 'multipart/form-data' in request.content_type:
            body = {
                'name': request.form.get('name', ''),
                'text': request.form.get('text', ''),
                'media_type': request.form.get('media_type', ''),
                'media_url': request.form.get('media_url', '')
            }
            uploaded = save_uploaded_media(request.files.get('media_file'))
            if uploaded:
                body['media_type'] = body.get('media_type') or uploaded['media_type']
                body['media_url'] = uploaded['media_url'] or body.get('media_url')
        else:
            data = request.get_data(as_text=True) or '{}'
            if len(data.encode('utf8')) > MAX_BODY_BYTES:
                return jsonify({'error': 'Payload too large'}), 413
            try:
                body = json.loads(data)
            except Exception:
                return jsonify({'error': 'Invalid JSON'}), 400

        comment = normalise_comment(body)
        if not comment:
            return jsonify({'error': 'Name and message are required'}), 400
        try:
            created = persist_comment_to_configured_backends(comment)
            return jsonify(created), 201
        except RuntimeError as exc:
            return jsonify({'error': str(exc)}), 507

    if request.method == 'DELETE':
        try:
            body = request.get_json(silent=True) or {}
        except Exception:
            body = {}
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
