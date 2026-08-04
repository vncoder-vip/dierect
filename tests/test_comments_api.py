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
