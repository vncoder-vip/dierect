import importlib
import os
import sys
import json
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, ROOT)


def _call_handler(module, method='GET', body=None):
    request = {
        'method': method,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body) if body else ''
    }
    return module.handler(request)


def _get_status(response):
    return response.get('statusCode', 500)


def _get_json(response):
    return json.loads(response.get('body', '{}'))


def test_api_comments_import():
    module = importlib.import_module('api.comments')
    assert hasattr(module, 'handler')
    assert hasattr(module, 'get_configured_sanity_storages')


def test_get_returns_200_or_503():
    module = importlib.import_module('api.comments')
    response = _call_handler(module, 'GET')
    status = _get_status(response)
    assert status in (200, 503)


def test_delete_returns_client_error():
    module = importlib.import_module('api.comments')
    response = _call_handler(module, 'DELETE', {})
    status = _get_status(response)
    assert status in (400, 401, 405)


def test_post_without_name_returns_400():
    module = importlib.import_module('api.comments')
    response = _call_handler(module, 'POST', {'text': 'hello'})
    status = _get_status(response)
    assert status == 400


def test_post_without_backend_returns_503():
    module = importlib.import_module('api.comments')
    with patch.object(module, 'get_configured_sanity_storages', return_value=[]):
        response = _call_handler(module, 'POST', {'name': 'Alice', 'text': 'Hello'})
        status = _get_status(response)
        assert status == 503


def test_get_enriches_sanity_comments_with_storage_metadata():
    module = importlib.import_module('api.comments')
    with patch.object(module, 'get_configured_sanity_storages', return_value=[{'id': 'primary', 'projectId': 'demo', 'dataset': 'production', 'token': 'token'}]):
        with patch.object(module, 'list_comments_from_storage_manager', return_value=[{
            'id': 'comment-1',
            'name': 'Alice',
            'text': 'Hello',
            'created_at': '2024-01-01T00:00:00Z',
            'storage_id': 'primary',
            'storage_label': 'Sanity #primary'
        }]):
            response = _call_handler(module, 'GET')
            status = _get_status(response)
            assert status == 200
            payload = _get_json(response)
            assert payload[0]['storage_id'] == 'primary'
            assert payload[0]['storage_label'] == 'Sanity #primary'


def test_get_returns_empty_list_when_sanity_reads_fail():
    module = importlib.import_module('api.comments')
    with patch.object(module, 'get_configured_sanity_storages', return_value=[{'id': 'primary', 'projectId': 'demo', 'dataset': 'production', 'token': 'token'}]):
        with patch.object(module, 'list_comments_from_storage_manager', side_effect=RuntimeError('boom')):
            response = _call_handler(module, 'GET')
            status = _get_status(response)
            assert status == 200
            payload = _get_json(response)
            assert payload == []