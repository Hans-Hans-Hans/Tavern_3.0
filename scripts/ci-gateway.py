"""Exercise the built Nginx routes against isolated protocol fixtures in CI.

This validates proxy admission and credential forwarding, not real SFU media or
Web Push delivery. It only creates/removes resources owned by this invocation.
"""
import base64
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
from pathlib import Path
import sys
import threading
import time
from urllib.parse import urlsplit
import uuid


def stub():
    if os.environ.get('TAVERN_CI_GATEWAY_STUB') != 'true':
        raise RuntimeError('The gateway fixture must be explicitly enabled.')
    counts = {'sfu': 0, 'raw': 0}

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_):
            pass

        def reply(self, code, value=None):
            body = json.dumps(value or {}).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlsplit(self.path).path
            if self.server.server_port == 8090:
                if path == '/api/__fixture/counters':
                    return self.reply(200, counts)
                if path == '/api/calls/sfu-authorize':
                    uri = self.headers.get('X-Tavern-RTC-URI', '')
                    valid = (uri.startswith('/livekit/sfu/rtc') and 'access_token=fixture' in uri
                             and self.headers.get('X-Tavern-RTC-Method') == 'GET'
                             and self.headers.get('Cookie') == 'fixture=authorized'
                             and self.headers.get('Origin') == 'https://chat.example.test')
                    if not valid:
                        return self.reply(403)
                    self.send_response(204)
                    self.end_headers()
                    return
            if self.server.server_port == 7880:
                counts['sfu'] += 1
                if self.headers.get('Content-Length') or self.headers.get('Transfer-Encoding'):
                    return self.reply(409, {'error': 'Uninspected request body reached the SFU'})
                if self.headers.get('Cookie'):
                    return self.reply(409, {'error': 'Browser cookie reached the SFU'})
                if self.headers.get('Upgrade', '').lower() == 'websocket':
                    key = self.headers.get('Sec-WebSocket-Key', '')
                    accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                    self.send_response(101)
                    self.send_header('Connection', 'Upgrade')
                    self.send_header('Upgrade', 'websocket')
                    self.send_header('Sec-WebSocket-Accept', accept)
                    self.end_headers()
                    return
                return self.reply(200, {'path': path})
            counts['raw'] += 1
            self.reply(418)

        def do_POST(self):
            if self.server.server_port == 8090 and self.path == '/api/matrix/_matrix/media/v3/upload':
                remaining = int(self.headers.get('Content-Length', 0))
                received = 0
                while remaining:
                    chunk = self.rfile.read(min(remaining, 65536))
                    if not chunk:
                        break
                    received += len(chunk)
                    remaining -= len(chunk)
                if self.headers.get('Cookie') != 'fixture=authorized' or self.headers.get('Authorization') != 'Bearer cookie-session:fixture':
                    return self.reply(401)
                return self.reply(200, {'received': received})
            self.rfile.read(min(int(self.headers.get('Content-Length', 0)), 32768))
            if self.server.server_port == 8090:
                if self.path in ('/api/calls/rtc-auth/get_token', '/api/calls/rtc-auth/sfu/get'):
                    if self.headers.get('Cookie') != 'fixture=authorized' or self.headers.get('Origin') != 'https://chat.example.test':
                        return self.reply(409)
                    return self.reply(202, {'path': self.path})
                if self.path == '/_matrix/push/v1/notify':
                    if self.headers.get('Cookie') or self.headers.get('Authorization'):
                        return self.reply(409)
                    return self.reply(200, {'rejected': []})
            counts['raw'] += 1
            self.reply(418)

    servers = [ThreadingHTTPServer(('0.0.0.0', port), Handler) for port in (8090, 7880, 8080, 8008)]
    for server in servers[:-1]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    servers[-1].serve_forever()


def main():
    root = Path(__file__).resolve().parents[1]
    if (os.environ.get('TAVERN_CI_SMOKE') != 'true' or os.environ.get('GITHUB_ACTIONS') != 'true'
            or sys.platform != 'linux' or Path(os.environ.get('GITHUB_WORKSPACE', '/missing')).resolve() != root):
        raise RuntimeError('Gateway checks require this checkout on its disposable GitHub Actions Linux runner.')
    import docker
    engine = docker.from_env()
    identity = 'tavern-ci-gateway-' + uuid.uuid4().hex[:12]
    owned = {'io.tavern.ci.gateway': identity}
    network = engine.networks.create(identity, labels=owned)
    containers = []
    try:
        fixture = engine.containers.create('tavern-integrations:check', ['python', '/ci/ci-gateway.py', '--stub'],
            name=identity + '-fixture', labels=owned, environment={'TAVERN_CI_GATEWAY_STUB': 'true'},
            volumes={str(Path(__file__).resolve()): {'bind': '/ci/ci-gateway.py', 'mode': 'ro'}},
            network=network.name, read_only=True, cap_drop=['ALL'], security_opt=['no-new-privileges:true'])
        containers.append(fixture)
        network.disconnect(fixture)
        network.connect(fixture, aliases=['tavern-api', 'livekit', 'rtc-auth', 'synapse'])
        fixture.start()
        gateway = engine.containers.run('tavern:check', name=identity + '-web', labels=owned, detach=True,
            environment={'TAVERN_DOMAIN': 'chat.example.test', 'TAVERN_MANAGED_AUTH': 'true'},
            network=network.name, ports={'8080/tcp': ('127.0.0.1', None)}, read_only=True,
            tmpfs={'/tmp': 'size=128m,mode=1777'}, cap_drop=['ALL'], security_opt=['no-new-privileges:true'])
        containers.append(gateway)
        gateway.reload()
        port = int(gateway.attrs['NetworkSettings']['Ports']['8080/tcp'][0]['HostPort'])

        def request(path, method='GET', headers=None, body=None):
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            try:
                connection.request(method, path, body=body, headers={'Host': 'chat.example.test', **(headers or {})})
                response = connection.getresponse()
                return response.status, response.read(32768)
            finally:
                connection.close()

        for attempt in range(30):
            try:
                if request('/api/__fixture/counters')[0] == 200:
                    break
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(1)
        else:
            raise AssertionError('The isolated gateway fixtures did not become ready.')
        headers = {'Origin': 'https://chat.example.test', 'Cookie': 'fixture=authorized'}
        # Validate the built files with production routing, including admin
        # chunks. Their names do not make them administration API endpoints.
        result = gateway.exec_run(['find', '/usr/share/nginx/html/assets', '-type', 'f'])
        assert result.exit_code == 0
        assets = ['/assets/' + line.rsplit('/', 1)[-1] for line in result.output.decode().splitlines()
                  if re.search(r'-[A-Za-z0-9_-]{8,}\.(js|css|wasm)$', line)]
        assert assets and any('/admin-' in path for path in assets)
        def cache_header(path):
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            try:
                connection.request('GET', path, headers={'Host': 'chat.example.test'})
                response = connection.getresponse()
                return response.status, response.getheader('Cache-Control'), response.getheader('X-Content-Type-Options')
            finally:
                connection.close()
        for path in assets:
            assert cache_header(path) == (200, 'public, max-age=31536000, immutable', 'nosniff'), path
        for path in ('/', '/index.html', '/tavern-config.json', '/api/__fixture/counters'):
            assert cache_header(path) == (200, 'no-store', 'nosniff'), path
        assert cache_header('/assets/missing-AbCd1234.js') == (404, 'no-store', 'nosniff')
        assert cache_header('/sw.js') == (200, 'no-cache', 'nosniff')
        # Exercise the real nested Nginx location: only attachment uploads get
        # the larger ceiling, retaining credentials for the quota-enforcing API.
        payload = b'x' * (16 * 1024 * 1024)
        status, body = request('/api/matrix/_matrix/media/v3/upload', 'POST', {**headers, 'Authorization': 'Bearer cookie-session:fixture'}, payload)
        assert status == 200 and json.loads(body)['received'] == len(payload), 'Attachments above the old gateway limit must reach the managed API intact.'
        for path, length in (('/api/matrix/_matrix/client/v3/rooms/room/send/m.room.message/1', len(payload)),
                             ('/api/admin/storage', len(payload)),
                             ('/api/matrix/_matrix/media/v3/upload', 512 * 1024 * 1024 + 1)):
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            try:
                # A known oversized body must be refused from headers alone.
                connection.putrequest('POST', path, skip_host=True)
                connection.putheader('Host', 'chat.example.test')
                connection.putheader('Content-Length', str(length))
                connection.endheaders()
                assert connection.getresponse().status == 413, 'Route must keep its bounded body limit: ' + path
            finally:
                connection.close()
        del payload
        for path in ('rtc', 'rtc/validate', 'rtc/v1', 'rtc/v1/validate'):
            public = '/livekit/sfu/' + path + '?access_token=fixture'
            assert request(public)[0] == 403, 'Unauthenticated signaling must be denied before the SFU.'
            status, body = request(public, headers=headers)
            assert status == 200 and json.loads(body)['path'] == '/' + path, 'Authorized signaling must preserve its pinned upstream path.'
        websocket = {**headers, 'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13'}
        assert request('/livekit/sfu/rtc?access_token=fixture', headers=websocket)[0] == 101
        assert request('/livekit/sfu/rtc/validate?access_token=fixture', headers={**headers, 'Content-Type': 'application/x-www-form-urlencoded'}, body='publish=uninspected')[0] == 200
        for route in ('get_token', 'sfu/get'):
            status, body = request('/livekit/jwt/' + route, 'POST', headers, '{}')
            assert status == 202 and json.loads(body)['path'] == '/api/calls/rtc-auth/' + route
        assert request('/_matrix/push/v1/notify', 'POST', {**headers, 'Authorization': 'Bearer fixture'}, '{}')[0] == 200
        for path in ('/livekit/jwt/unknown', '/livekit/jwt/delegate_delayed_leave', '/livekit/sfu/twirp/livekit.RoomService/ListParticipants',
                     '/livekit/sfu/rtc/other', '/_tavern/rtc-authorize', '/_matrix/push/other'):
            assert request(path, headers=headers)[0] == 404
        for version in ('v3', 'r0', 'unstable', 'api/v1'):
            assert request('/_matrix/client/' + version + '/pushers/set', 'POST', headers, '{}')[0] == 403
        # Synapse 1.160 also registers the legacy media/v1 upload alias. Test
        # actual Nginx URI normalization, not a Python approximation of it.
        media_paths = (
            '/_matrix/media/v1/upload', '/_matrix/media/r0/upload', '/_matrix/media/v3/upload',
            '/_matrix/media/v1/create', '/_matrix/client/v1/media/create', '/_matrix/client/v3/media/upload',
            '/_matrix/media/v1/upload/chat.example.test/chosen-id',
            '/_matrix/media/%76%31/upload', '/_matrix/%6dedia/v1/%75pload',
            '/_matrix/media/v1%2fupload', '/_matrix//media/v1/upload',
            '/_matrix/media/v3/../v1/upload', '/_matrix/media/v1/%2e/upload',
            '/_matrix/media/v1/upload?filename=quota-fixture.bin',
        )
        for path in media_paths:
            for method in ('POST', 'PUT'):
                assert request(path, method, {**headers, 'Authorization': 'Bearer fixture'}, 'opaque-bytes')[0] == 403, 'Native media aliases must not bypass upload quotas: ' + path
        for path in ('/api/internal/system-events', '/api/internal/system-deliveries/authorize', '/api/internal/server-eligibility'):
            for method in ('GET', 'POST'):
                assert request(path, method, headers)[0] == 404, 'Internal callbacks must not be publicly routed.'
        counts = json.loads(request('/api/__fixture/counters')[1])
        assert counts == {'sfu': 6, 'raw': 0}, 'Denied and unknown requests must never reach private raw services.'
        # Existing authenticated native media reads must still reach Synapse;
        # the isolated upstream uses 418 to identify deliberate forwarding.
        assert request('/_matrix/media/v3/download/chat.example.test/known-id', headers={'Authorization': 'Bearer fixture'})[0] == 418
        assert json.loads(request('/api/__fixture/counters')[1]) == {'sfu': 6, 'raw': 1}
        print('PASS: built Nginx enforces call admission for HTTP/WebSocket paths, routes auth and push requests explicitly, strips cookies from SFU/push traffic, blocks native upload/pusher aliases and raw service paths, and preserves media reads.')
    finally:
        for container in reversed(containers):
            container.reload()
            if container.labels.get('io.tavern.ci.gateway') == identity:
                container.remove(force=True)
        network.reload()
        if network.attrs.get('Labels', {}).get('io.tavern.ci.gateway') == identity:
            network.remove()
        engine.close()


if __name__ == '__main__':
    stub() if sys.argv[1:] == ['--stub'] else main()
