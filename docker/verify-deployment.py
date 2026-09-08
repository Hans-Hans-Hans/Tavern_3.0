#!/usr/bin/env python3
"""Read-only checks for a deployed Tavern NPM instance. Does not log in or change data."""
import argparse
import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('origin', help='https://chat.example.com')
args = parser.parse_args()
url = urlparse(args.origin)
if url.scheme != 'https' or not url.netloc or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
    parser.error('Provide only the HTTPS origin of your Tavern instance.')
origin = args.origin.rstrip('/')

def fetch(path):
    try:
        with urlopen(Request(origin + path, headers={'User-Agent': 'Tavern-deployment-check/0.3'}), timeout=20) as response:
            if not response.url.startswith(origin + '/'):
                raise RuntimeError('Unexpected redirect outside the Tavern origin.')
            return response.status, response.headers, response.read(2 * 1024 * 1024)
    except HTTPError as error:
        return error.code, error.headers, error.read(4096)

try:
    status, headers, body = fetch('/')
    assert status == 200 and b'Tavern' in body, 'Client page is not being served.'
    assert 'default-src' in headers.get('Content-Security-Policy', ''), 'Missing client CSP.'
    status, _, body = fetch('/tavern-config.json')
    config = json.loads(body)
    assert status == 200 and config['homeserverUrl'] == origin and config['lockHomeserver'] is True, 'Incorrect instance configuration.'
    status, _, body = fetch('/_matrix/client/versions')
    assert status == 200 and json.loads(body).get('versions'), 'Matrix version discovery failed.'
    for path in ['/_synapse/admin/v1/server_version', '/_matrix/federation/v1/version', '/_matrix/key/v2/server']:
        status, _, _ = fetch(path)
        assert status == 404, f'Expected 404 for blocked path: {path}; got {status}.'
except (AssertionError, KeyError, ValueError, RuntimeError, URLError) as error:
    raise SystemExit(f'FAILED: {error}')
print('PASS: HTTPS client/config, Matrix discovery, and blocked public admin/federation/key routes.')
print('Still required: two-account messaging, encryption recovery, permissions, voice/video/conferencing, and backup/restore tests.')
