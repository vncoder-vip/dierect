import importlib
import os
import sys

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, ROOT)


def test_api_comments_import_and_route():
    module = importlib.import_module('api.comments')
    client = module.app.test_client()
    response = client.get('/api/comments')
    assert response.status_code in (200, 503)


def test_delete_route_returns_client_error_instead_of_server_error():
    module = importlib.import_module('api.comments')
    client = module.app.test_client()
    response = client.delete('/api/comments', json={'id': '1'})
    assert response.status_code in (400, 401, 405)


def test_delete_sanity_comment_uses_document_and_storage_id(monkeypatch):
    module = importlib.import_module('api.comments')
    storage = {'id': 'primary', 'projectId': 'demo', 'dataset': 'production', 'token': 'token'}
    calls = []
    monkeypatch.setenv('ADMIN_DELETE_PASSWORD', 'secret')
    monkeypatch.setattr(module, 'get_configured_sanity_storages', lambda: [storage])

    def fake_sanity_request(storage_arg, endpoint, method='GET', json_body=None):
        calls.append((storage_arg, endpoint, method, json_body))
        return {'transactionId': 'transaction-1'}

    monkeypatch.setattr(module, 'sanity_request', fake_sanity_request)
    response = module.app.test_client().delete(
        '/api/comments',
        json={'id': 'comment-1', 'storage_id': 'primary', 'password': 'secret'}
    )

    assert response.status_code == 200
    assert response.get_json()['deleted'] is True
    assert calls[0][0]['id'] == 'primary'
    assert calls[0][2] == 'POST'
    assert calls[0][3] == {'mutations': [{'delete': {'id': 'comment-1'}}]}


def test_delete_sanity_comment_rejects_unknown_storage(monkeypatch):
    module = importlib.import_module('api.comments')
    monkeypatch.setenv('ADMIN_DELETE_PASSWORD', 'secret')
    monkeypatch.setattr(module, 'get_configured_sanity_storages', lambda: [
        {'id': 'primary', 'projectId': 'demo', 'dataset': 'production', 'token': 'token'}
    ])

    response = module.app.test_client().delete(
        '/api/comments',
        json={'id': 'comment-1', 'storage_id': 'missing', 'password': 'secret'}
    )

    assert response.status_code == 400
    assert response.get_json()['error'] == 'Unknown Sanity storage'


def test_api_enriches_sanity_comments_with_storage_metadata(monkeypatch):
    module = importlib.import_module('api.comments')
    monkeypatch.setattr(module, 'get_configured_sanity_storages', lambda: [{'id': 'primary', 'projectId': 'demo', 'dataset': 'production', 'token': 'token'}])
    monkeypatch.setattr(module, 'list_comments_from_storage_manager', lambda: [{
        'id': 'comment-1',
        'name': 'Alice',
        'text': 'Hello',
        'created_at': '2024-01-01T00:00:00Z'
    }])

    client = module.app.test_client()
    response = client.get('/api/comments')

    assert response.status_code == 200
    payload = response.get_json()
    assert payload[0]['storage_id'] == 'primary'
    assert payload[0]['storage_label'] == 'Sanity #primary'


def test_api_returns_empty_list_when_sanity_reads_fail(monkeypatch):
    module = importlib.import_module('api.comments')
    monkeypatch.setattr(module, 'get_configured_sanity_storages', lambda: [{'id': 'primary', 'projectId': 'demo', 'dataset': 'production', 'token': 'token'}])
    monkeypatch.setattr(module, 'list_comments_from_storage_manager', lambda: (_ for _ in ()).throw(RuntimeError('boom')))

    client = module.app.test_client()
    response = client.get('/api/comments')

    assert response.status_code == 200
    assert response.get_json() == []


def test_api_keeps_comments_when_one_sanity_storage_fails(monkeypatch):
    module = importlib.import_module('api.comments')
    storages = [
        {'id': 'primary', 'projectId': 'demo', 'dataset': 'production', 'token': 'token'},
        {'id': '1', 'projectId': 'unavailable', 'dataset': 'production', 'token': 'token'},
    ]
    monkeypatch.setattr(module, 'get_configured_sanity_storages', lambda: storages)

    def fake_get_comments(storage):
        if storage['id'] == '1':
            raise TimeoutError('storage timeout')
        return [{'id': 'comment-1', 'name': 'Alice', 'text': 'Hello', 'created_at': '2024-01-01T00:00:00Z'}]

    monkeypatch.setattr(module, 'get_comments_from_storage', fake_get_comments)

    comments = module.list_comments_from_storage_manager()

    assert len(comments) == 1
    assert comments[0]['storage_id'] == 'primary'
    assert comments[0]['storage_label'] == 'Sanity #primary'


def test_full_flask_entrypoint_can_import_and_serve_root():
    module = importlib.import_module('app')
    response = module.app.test_client().get('/')

    assert response.status_code == 200
