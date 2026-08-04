import importlib
import os
import sys
import json
import io
from unittest.mock import MagicMock, patch

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, ROOT)


def _make_handler(module):
    """Create a handler instance with mocked socket for testing."""
    h = module.handler.__new__(module.handler)
    h.rfile = io.BytesIO()
    h.wfile = io.BytesIO()
    h.headers = {}
    h.send_response = MagicMock()
    h.send_header = MagicMock()
    h.end_headers = MagicMock()
    h.log_message = MagicMock()
    return h


def _get_response_body(h):
    h.wfile.seek(0)
    return json.loads(h.wfile.read().decode('utf-8'))


def test_api_comments_import():
    module = importlib.import_module('api.comments')
    assert hasattr(module, 'handler')
    assert hasattr(module, 'get_configured_sanity_storages')


def test_get_returns_200_or_503():
    module = importlib.import_module('api.comments')
    h = _make_handler(module)
    h.do_GET()
    status = h.send_response.call_args[0][0]
    assert status in (200, 503)


def test_delete_returns_client_error():
    module = importlib.import_module('api.comments')
    h = _make_handler(module)
    h.headers = {'Content-Length': '0'}
    h.do_DELETE()
    status = h.send_response.call_args[0][0]
    assert status in (400, 401, 405)


def test_post_without_name_returns_400():
    module = importlib.import_module('api.comments')
    body = json.dumps({'text': 'hello'}).encode('utf-8')
    h = _make_handler(module)
    h.rfile = io.BytesIO(body)
    h.headers = {'Content-Length': str(len(body)), 'Content-Type': 'application/json'}
    h.do_POST()
    status = h.send_response.call_args[0][0]
    assert status == 400


def test_post_without_backend_returns_503():
    module = importlib.import_module('api.comments')
    with patch.object(module, 'get_configured_sanity_storages', return_value=[]):
        body = json.dumps({'name': 'Alice', 'text': 'Hello'}).encode('utf-8')
        h = _make_handler(module)
        h.rfile = io.BytesIO(body)
        h.headers = {'Content-Length': str(len(body)), 'Content-Type': 'application/json'}
        h.do_POST()
        status = h.send_response.call_args[0][0]
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
            h = _make_handler(module)
            h.do_GET()
            status = h.send_response.call_args[0][0]
            assert status == 200
            payload = _get_response_body(h)
            assert payload[0]['storage_id'] == 'primary'
            assert payload[0]['storage_label'] == 'Sanity #primary'


def test_get_returns_empty_list_when_sanity_reads_fail():
    module = importlib.import_module('api.comments')
    with patch.object(module, 'get_configured_sanity_storages', return_value=[{'id': 'primary', 'projectId': 'demo', 'dataset': 'production', 'token': 'token'}]):
        with patch.object(module, 'list_comments_from_storage_manager', side_effect=RuntimeError('boom')):
            h = _make_handler(module)
            h.do_GET()
            status = h.send_response.call_args[0][0]
            assert status == 200
            payload = _get_response_body(h)
            assert payload == []