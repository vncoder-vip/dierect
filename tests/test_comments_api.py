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
