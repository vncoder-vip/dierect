import os
import json
import datetime
from flask import Flask, request, jsonify

app = Flask(__name__)

MAX_BODY_BYTES = 16 * 1024

# Postgres optional
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


def normalise_comment(input_data):
    name = str((input_data.get('name') if isinstance(input_data, dict) else '') or '').strip()[:24]
    text = str((input_data.get('text') if isinstance(input_data, dict) else '') or '').strip()[:120]
    return {'name': name, 'text': text} if name and text else None


def sanity_configured():
    return bool(os.environ.get('SANITY_PROJECT_ID') and os.environ.get('SANITY_API_TOKEN'))


def sanity_api_version():
    configured = os.environ.get('SANITY_API_VERSION', '')
    return configured if configured and len(configured) >= 10 else '2026-07-28'


@app.route('/', methods=['GET', 'POST', 'DELETE'])
def handle():
    # Prefer Postgres if configured
    if pool:
        return comments_postgres()
    if sanity_configured():
        return comments_sanity()
    return jsonify({'error': 'No backend configured'}), 503


def comments_postgres():
    from psycopg2.extras import RealDictCursor
    if request.method == 'GET':
        conn = pool.getconn()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute('SELECT id, name, text, created_at FROM comments ORDER BY created_at DESC LIMIT 100')
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
                    'INSERT INTO comments (name, text) VALUES (%s, %s) RETURNING id, name, text, created_at',
                    (comment['name'], comment['text'])
                )
                created = cur.fetchone()
                conn.commit()
            return jsonify(created), 201
        finally:
            pool.putconn(conn)

    return jsonify({'error': 'Not supported'}), 405


def comments_sanity():
    import requests
    import urllib.parse as urlparse
    project = os.environ.get('SANITY_PROJECT_ID')
    dataset = os.environ.get('SANITY_DATASET', 'production')
    token = os.environ.get('SANITY_API_TOKEN')
    api_ver = sanity_api_version()
    base = f'https://{project}.api.sanity.io/v{api_ver}'

    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

    if request.method == 'GET':
        groq = '*[_type == "comment"] | order(createdAt asc)[0...100]{_id, name, text, createdAt}'
        url = f"{base}/data/query/{dataset}?query={urlparse.quote(groq)}"
        r = requests.get(url, headers=headers, timeout=10)
        r.raise_for_status()
        result = r.json()
        comments = result.get('result', [])
        out = [{'id': c.get('_id'), 'name': c.get('name'), 'text': c.get('text'), 'created_at': c.get('createdAt')} for c in comments]
        return jsonify(out), 200

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
        mutate_url = f"{base}/data/mutate/{dataset}?returnIds=true"
        payload = {"mutations": [{"create": {"_type": "comment", "name": comment['name'], "text": comment['text'], "createdAt": datetime.datetime.utcnow().isoformat()}}]}
        r = requests.post(mutate_url, headers=headers, json=payload, timeout=10)
        r.raise_for_status()
        created = r.json()
        ids = created.get('result', [])
        return jsonify({'id': ids[0].get('_id') if ids else None, 'name': comment['name'], 'text': comment['text'], 'created_at': comment.get('createdAt')}), 201

    if request.method == 'DELETE':
        delete_password = str(body.get('password') or '') if isinstance(body, dict) else ''
        if not os.environ.get('ADMIN_DELETE_PASSWORD') or delete_password != os.environ.get('ADMIN_DELETE_PASSWORD'):
            return jsonify({'error': 'Invalid admin password'}), 401
        id_ = str(body.get('id') or '')
        if not id_:
            return jsonify({'error': 'Invalid comment id'}), 400
        del_url = f"{base}/data/mutate/{dataset}?returnIds=true"
        del_payload = {"mutations": [{"delete": {"id": id_}}]}
        r = requests.post(del_url, headers=headers, json=del_payload, timeout=10)
        if r.status_code in (200, 204):
            return ('', 204)
        return jsonify({'error': 'Delete failed', 'detail': r.text}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 10000)))
