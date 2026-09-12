"""Execute production Nginx routes when NGINX_BINARY points to a local binary.

The Docker gateway workflow also checks headers on the actual built assets.
This fixture binds loopback only and never starts or changes Docker services.
"""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get('NGINX_BINARY'), 'Set NGINX_BINARY to execute real static and gateway cache checks')
class StaticCacheTests(unittest.TestCase):
    def exercise(self, gateway):
        executable = Path(os.environ['NGINX_BINARY']).resolve()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'{}')

        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream.shutdown)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'logs').mkdir()
            (root / 'temp').mkdir()
            html = root / 'html'
            (html / 'assets').mkdir(parents=True)
            for path in ('index.html', 'tavern-config.json', 'sw.js', 'service-worker.js',
                         'assets/index-AbCd1234.js', 'assets/admin-integrations-aB_123-9.js',
                         'assets/index-AbCd1234.css', 'assets/crypto-AbCd1234.wasm', 'assets/unhashed.js'):
                (html / path).write_text('fixture', encoding='utf-8')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            source = (ROOT / ('docker/npm/server.conf.template' if gateway else 'docker/nginx.conf')).read_text()
            for key, value in {'TAVERN_DOMAIN': 'chat.example.test', 'TAVERN_MANAGED_AUTH': 'true',
                               'TAVERN_ROLE_POLICY': 'true', 'CALLS_ENABLED': 'false'}.items():
                source = source.replace('${' + key + '}', value)
            source = source.replace('listen 8080;', f'listen 127.0.0.1:{port};')
            source = source.replace('/usr/share/nginx/html', html.as_posix())
            source = source.replace('include /etc/nginx/mime.types;', '')
            includes = {'tavern-cache-control.conf': 'docker/cache-control.conf',
                        'tavern-headers.conf': 'docker/npm/headers.conf',
                        'tavern-call-headers.conf': 'docker/npm/call-headers.conf'}
            for name, path in includes.items():
                source = source.replace('/etc/nginx/' + name, (ROOT / path).as_posix())
            source = source.replace('/dev/null', (root / 'muted.log').as_posix())
            for address in ('tavern-api:8090', 'synapse:8008', 'integrations:8080', 'livekit:7880'):
                source = source.replace(address, f'127.0.0.1:{upstream.server_port}')
            cache = (ROOT / 'docker/cache-control.conf').read_text() if gateway else ''
            config = root / 'nginx.conf'
            config.write_text(f'daemon off; master_process off; error_log logs/error.log warn; events {{ worker_connections 64; }} http {{ access_log off; {cache} {source} }}')
            flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
            command = [str(executable), '-p', root.as_posix() + '/', '-c', str(config)]
            checked = subprocess.run(command + ['-t'], capture_output=True, text=True, **flags)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **flags)
            def request(path, headers=None):
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                try:
                    connection.request('GET', path, headers=headers or {})
                    response = connection.getresponse()
                    result = response.status, dict(response.getheaders()), response.read()
                    return result
                finally:
                    connection.close()
            try:
                for _ in range(50):
                    try:
                        if request('/health')[0] == 200:
                            break
                    except OSError:
                        time.sleep(.1)
                else:
                    self.fail('Nginx did not start')
                immutable = 'public, max-age=31536000, immutable'
                for path in ('/assets/index-AbCd1234.js', '/assets/admin-integrations-aB_123-9.js',
                             '/assets/index-AbCd1234.css', '/assets/crypto-AbCd1234.wasm'):
                    with self.subTest(path=path, gateway=gateway):
                        status, headers, _ = request(path)
                        self.assertEqual(status, 200)
                        self.assertEqual(headers['Cache-Control'], immutable)
                        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
                        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
                        status, headers, _ = request(path, {'If-Modified-Since': headers['Last-Modified']})
                        self.assertEqual(status, 304)
                        self.assertEqual(headers['Cache-Control'], immutable)
                for path in ('/', '/index.html', '/channels/example', '/tavern-config.json', '/assets/unhashed.js'):
                    self.assertEqual(request(path)[1]['Cache-Control'], 'no-store', path)
                status, headers, _ = request('/assets/missing-AbCd1234.js')
                self.assertEqual(status, 404)
                self.assertEqual(headers['Cache-Control'], 'no-store')
                for path in ('/sw.js', '/service-worker.js'):
                    self.assertEqual(request(path)[1]['Cache-Control'], 'no-cache', path)
                if gateway:
                    for path in ('/api/auth/session', '/api/matrix/_matrix/client/versions'):
                        status, headers, _ = request(path)
                        self.assertEqual(status, 200)
                        self.assertEqual(headers['Cache-Control'], 'no-store')
                    for path in ('/_synapse/admin/v2/users', '/livekit/sfu/twirp/livekit.RoomService/CreateRoom'):
                        status, headers, _ = request(path)
                        self.assertEqual(status, 404)
                        self.assertEqual(headers['Cache-Control'], 'no-store')
            finally:
                process.terminate()
                process.wait(timeout=10)

    def test_static_image_headers(self):
        self.exercise(False)

    def test_managed_gateway_headers_and_private_paths(self):
        self.exercise(True)
