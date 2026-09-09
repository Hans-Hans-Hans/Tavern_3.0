import asyncio
import base64
import copy
import datetime
import json
import socket
import ssl
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import aiohttp
import http_ece
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from py_vapid import Vapid02

from api.push_transport import GuardedResolver, PublicResolver, bounded_json, send_push, subscription_value
from api.server import APIError
from tests.test_push_notifications import browser_subscription


class PushTransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'push.example.org')])
        now = datetime.datetime.now(datetime.timezone.utc)
        certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                       .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=1))
                       .not_valid_after(now + datetime.timedelta(days=1))
                       .add_extension(x509.SubjectAlternativeName([x509.DNSName('push.example.org')]), critical=False)
                       .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).sign(key, hashes.SHA256()))
        cert_path, key_path = Path(self.directory.name) / 'certificate.pem', Path(self.directory.name) / 'key.pem'
        cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        server_ssl = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_ssl.load_cert_chain(cert_path, key_path)
        client_ssl = ssl.create_default_context(cafile=str(cert_path))
        self.requests = []
        async def provider(request):
            self.requests.append((request.path, dict(request.headers), await request.read()))
            if request.path == '/redirect':
                return web.Response(status=307, headers={'Location': 'https://127.0.0.1/private'})
            if request.path == '/unbounded':
                response = web.StreamResponse(status=503, headers={'Content-Length': '999999999999', 'Content-Encoding': 'gzip', 'Retry-After': '999999'})
                await response.prepare(request)
                return response
            return web.Response(status=201, body=b'ignored')
        app = web.Application(); app.router.add_post('/{path:.*}', provider)
        self.server = TestServer(app); await self.server.start_server(ssl=server_ssl)
        self.addAsyncCleanup(self.server.close)
        async def resolve(resolver, host, port=0, family=socket.AF_UNSPEC):
            self.assertEqual(host, 'push.example.org'); self.assertEqual(port, 443)
            return [{'hostname': host, 'host': '127.0.0.1', 'port': self.server.port, 'family': socket.AF_INET, 'proto': socket.IPPROTO_TCP, 'flags': socket.AI_NUMERICHOST}]
        self.resolve = resolve
        original_connector = aiohttp.TCPConnector
        def connector(**kwargs):
            self.assertFalse(kwargs['use_dns_cache'])
            self.assertIsInstance(kwargs['resolver'], GuardedResolver)
            return original_connector(**kwargs, ssl=client_ssl)
        self.connector_patch = patch('api.push_transport.aiohttp.TCPConnector', connector)
        self.connector_patch.start(); self.addCleanup(self.connector_patch.stop)
        self.subscription, self.recipient_key = browser_subscription()
        self.vapid = Vapid02(); self.vapid.generate_keys()
        self.payload = {'v': 1, 'kind': 'activity', 'generation': 'opaque-generation', 'ticket': 'opaque-ticket', 'expiresAt': int(time.time() * 1000) + 60000}

    async def send(self, path='/delivery', authorize=lambda: None, reauthorize=None):
        subscription = {**self.subscription, 'endpoint': 'https://push.example.org' + path}
        return await send_push(subscription, self.vapid.private_pem().decode(), 'https://tavern.example.org', self.payload, 99999, authorize, reauthorize)

    async def test_real_tls_delivery_encrypts_for_recipient_and_signs_exact_provider_origin(self):
        refreshed = AsyncMock()
        with patch.object(PublicResolver, 'resolve', self.resolve):
            self.assertEqual(await self.send(reauthorize=refreshed), (201, 0))
        refreshed.assert_awaited_once()
        self.assertEqual(len(self.requests), 1)
        path, headers, ciphertext = self.requests[0]
        self.assertEqual(path, '/delivery')
        self.assertNotIn(b'opaque-ticket', ciphertext)
        plaintext = http_ece.decrypt(ciphertext, private_key=self.recipient_key, auth_secret=b'0123456789abcdef', version='aes128gcm')
        self.assertEqual(json.loads(plaintext), self.payload)
        self.assertLessEqual(len(ciphertext), 4096)
        self.assertEqual(headers['Content-Encoding'], 'aes128gcm')
        self.assertEqual(headers['TTL'], '300')
        self.assertEqual(headers['Accept-Encoding'], 'identity')
        self.assertFalse({'Cookie', 'Referer'} & headers.keys())
        self.assertTrue(Vapid02.verify(headers['Authorization']))
        token = headers['Authorization'].split('t=', 1)[1].split(',', 1)[0]
        claims = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '==='))
        self.assertEqual(claims['aud'], 'https://push.example.org')
        self.assertEqual(claims['sub'], 'https://tavern.example.org')
        self.assertTrue(time.time() < claims['exp'] <= time.time() + 3600)

    async def test_redirect_is_not_followed_and_unbounded_compressed_body_is_not_read(self):
        with patch.object(PublicResolver, 'resolve', self.resolve):
            self.assertEqual(await self.send('/redirect'), (307, 0))
            self.assertEqual(await asyncio.wait_for(self.send('/unbounded'), 2), (503, 300))
        self.assertEqual([row[0] for row in self.requests], ['/redirect', '/unbounded'])

    async def test_revocation_during_dns_and_remote_reauthorization_prevent_provider_bytes(self):
        live = True
        def authorize():
            if not live: raise APIError(401, 'Expired', 'PUSH_EXPIRED')
        original = self.resolve
        async def revoked(resolver, *args, **kwargs):
            nonlocal live
            result = await original(resolver, *args, **kwargs)
            live = False
            return result
        with patch.object(PublicResolver, 'resolve', revoked):
            with self.assertRaises(APIError): await self.send(authorize=authorize)
        self.assertFalse(self.requests)
        live = True
        async def remote_change():
            raise APIError(403, 'No longer joined', 'PUSH_SUPPRESSED')
        with patch.object(PublicResolver, 'resolve', original):
            with self.assertRaises(APIError): await self.send(authorize=authorize, reauthorize=remote_change)
        self.assertFalse(self.requests)

    async def test_dns_rejects_any_private_answer_before_connection(self):
        loop = asyncio.get_running_loop()
        public = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('1.1.1.1', 443))
        private = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('127.0.0.1', 443))
        for answers in ([], [private], [public, private]):
            with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=answers)):
                with self.assertRaises(APIError): await GuardedResolver(lambda: None).resolve('push.example.org', 443)
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=[public])):
            result = await GuardedResolver(lambda: None).resolve('push.example.org', 443)
            self.assertEqual(result[0]['host'], '1.1.1.1')

    async def test_subscription_rejects_private_ambiguous_urls_keys_and_expiration(self):
        for endpoint in ('http://push.example.org/a', 'https://127.0.0.1/a', 'https://2130706433/a', 'https://user:pass@push.example.org/a',
                         'https://push.example.org:8443/a', 'https://push.example.org/a#secret', 'https://push.example.org/\\bad', 'https://localhost/a', 'https://push.example.org/a\x7f'):
            with self.subTest(endpoint=endpoint), self.assertRaises(APIError):
                subscription_value({**self.subscription, 'endpoint': endpoint})
        for key, value in (('auth', 'A'), ('auth', self.subscription['keys']['auth'] + '='), ('p256dh', 'A' * 87)):
            with self.assertRaises(APIError): subscription_value({**self.subscription, 'keys': {**self.subscription['keys'], key: value}})
        for expiration in (True, -1, float('nan'), float('inf'), 253402300800000):
            with self.assertRaises(APIError): subscription_value({**self.subscription, 'expirationTime': expiration})
        original = copy.deepcopy(self.subscription)
        self.assertEqual(subscription_value(original), original)


class NativePushResponseTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_response_limits_json_shape_duplicates_and_encoding(self):
        bodies = {'valid': (b'{"deactivated":false}', {}), 'duplicate': (b'{"deactivated":false,"deactivated":true}', {}),
                  'nan': (b'{"value":NaN}', {}), 'html': (b'<html>maintenance</html>', {}),
                  'large': (b'x' * 1025, {}), 'compressed': (b'pretend gzip', {'Content-Encoding': 'gzip'})}
        async def handler(request):
            body, headers = bodies[request.match_info['kind']]
            return web.Response(body=body, headers=headers)
        app = web.Application(); app.router.add_get('/{kind}', handler)
        server = TestServer(app); await server.start_server()
        self.addAsyncCleanup(server.close)
        async with aiohttp.ClientSession(auto_decompress=False) as client:
            for kind in bodies:
                async with client.get(server.make_url('/' + kind)) as response:
                    if kind == 'valid': self.assertEqual(await bounded_json(response, 1024), {'deactivated': False})
                    else:
                        with self.assertRaises(APIError): await bounded_json(response, 1024)


if __name__ == '__main__':
    unittest.main()
