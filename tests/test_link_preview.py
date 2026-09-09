import asyncio
import socket
import unittest
from unittest.mock import AsyncMock, patch
from aiohttp import web
from aiohttp.test_utils import TestServer
from api.link_preview import Metadata, PublicResolver, preview_url, public_address, fetch_preview, MAX_BYTES
from api.server import APIError
from tests import test_api as fixture

class LinkPreviewTests(unittest.IsolatedAsyncioTestCase):
    def test_urls_reject_local_networks_credentials_protocols_and_translation(self):
        for value in ['http://127.0.0.1', 'http://10.10.30.80', 'http://[::1]', 'http://[64:ff9b::7f00:1]', 'http://169.254.169.254', 'http://100.64.0.1', 'http://localhost.', 'http://service.internal', 'http://user:secret@example.com', 'https://example.com:2375', 'file:///etc/passwd', 'http://2130706433', 'http://127.1', 'http://0177.0.0.1', 'http://[2606:4700:4700::1111%25eth0]']:
            with self.subTest(value=value), self.assertRaises(APIError):
                preview_url(value)
        self.assertEqual(str(preview_url('https://example.com/path#fragment')), 'https://example.com/path')
        self.assertFalse(public_address('::ffff:127.0.0.1'))

    async def test_resolver_rejects_private_or_mixed_dns_answers_and_pins_public_addresses(self):
        loop = asyncio.get_running_loop()
        def answer(address):
            return socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (address, 443)
        for answers in [[answer('127.0.0.1')], [answer('93.184.216.34'), answer('192.168.1.2')]]:
            with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=answers)), self.assertRaises(APIError):
                await PublicResolver().resolve('public-looking.example', 443)
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=[answer('93.184.216.34')])) as dns:
            value = await PublicResolver().resolve('example.com', 443)
            self.assertEqual(value[0]['host'], '93.184.216.34')
            self.assertEqual(value[0]['hostname'], 'example.com')
            self.assertEqual(dns.await_count, 1)

    def test_metadata_is_bounded_text_and_never_returns_remote_embeds(self):
        parser = Metadata()
        parser.feed('<title>Fallback</title><meta property="og:title" content="A &amp; B"><meta name="description" content="' + 'x' * 5000 + '"><meta property="og:image" content="http://127.0.0.1/admin"><script>alert(1)</script>')
        value = parser.result(preview_url('https://example.com'))
        self.assertEqual(value['title'], 'A & B')
        self.assertEqual(len(value['description']), 500)
        self.assertNotIn('image', value)
        self.assertNotIn('alert(1)', str(value))

    async def test_http_redirects_revalidate_destination_and_do_not_replay_server_cookies(self):
        received = []
        async def page(request):
            received.append((request.path, dict(request.headers)))
            if request.path == '/private': return web.Response(status=302, headers={'Location': 'http://127.0.0.1/admin'})
            if request.path == '/credentials': return web.Response(status=302, headers={'Location': 'https://user:password@example.org/'})
            if request.path == '/start': return web.Response(status=302, headers={'Location': '/end', 'Set-Cookie': 'remote-secret=secret; Path=/'})
            if request.path == '/large': return web.Response(text='<title>Small title</title>' + 'x' * MAX_BYTES + '<meta name="description" content="Beyond limit">', content_type='text/html')
            return web.Response(text='<title>Public page</title>', content_type='text/html')
        app = web.Application(); app.router.add_get('/{tail:.*}', page)
        server = TestServer(app); await server.start_server()
        # Reroute the validated public connection to a local fixture server.
        # URL parsing, redirect handling, cookies and response limits stay real.
        async def fixture_address(resolver, host, port=0, family=socket.AF_UNSPEC):
            return [{'hostname': host, 'host': '127.0.0.1', 'port': server.port, 'family': socket.AF_INET, 'proto': socket.IPPROTO_TCP, 'flags': socket.AI_NUMERICHOST}]
        try:
            with patch.object(PublicResolver, 'resolve', fixture_address):
                for route in ('private', 'credentials'):
                    before = len(received)
                    with self.assertRaises(APIError): await fetch_preview('http://example.org/' + route)
                    self.assertEqual(len(received), before + 1, 'Forbidden redirect must never open a second connection')
                result = await fetch_preview('http://example.org/start')
                self.assertEqual(result['title'], 'Public page')
                for _, headers in received:
                    self.assertNotIn('Cookie', headers); self.assertNotIn('Authorization', headers); self.assertNotIn('Referer', headers)
                result = await fetch_preview('http://example.org/large')
                self.assertEqual(result['title'], 'Small title'); self.assertEqual(result['description'], '')
        finally:
            await server.close()


class PreviewAPITests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.AccountAPITests.asyncSetUp
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def test_outbound_preview_requires_active_session_explicit_consent_and_same_origin(self):
        with patch('api.link_preview.fetch_preview', AsyncMock(return_value={'title': 'Public'})) as fetch:
            response = await self.request('POST', '/api/link-preview', {'url': 'https://example.org', 'consent': True})
            self.assertEqual(response.status, 401)
            cookie, _, _ = await self.login()
            response = await self.request('POST', '/api/link-preview', {'url': 'https://example.org'}, cookie)
            self.assertEqual(response.status, 400)
            response = await self.request('POST', '/api/link-preview', {'url': 'https://example.org', 'consent': True}, cookie, origin='https://evil.example')
            self.assertEqual(response.status, 403); fetch.assert_not_called()
            response = await self.request('POST', '/api/link-preview', {'url': 'https://example.org', 'consent': True}, cookie)
            self.assertEqual(response.status, 200); fetch.assert_awaited_once_with('https://example.org')
