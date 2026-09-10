"""Actual local HTTP probes, fixed-output privacy and zero-mutation contracts."""
import asyncio
import base64
import contextlib
import hashlib
import hmac
import io
import json
import os
import ssl
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from api import call_diagnostics as doctor
from api.server import Config


class CallDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.key, self.secret = 'diagnostic_fixture_key', 'fixture-secret-never-print-' + 'x' * 32
        (self.root / 'livekit_key').write_text(self.key)
        (self.root / 'livekit_secret').write_text(self.secret)
        self.env = patch.dict(os.environ, {'CALLS_ENABLED': 'true', 'CALL_CONFIG_DIR': str(self.root),
            'RTC_AUTH_IMAGE': doctor.SUPPORTED_AUTH_IMAGE}, clear=False)
        self.env.start()
        self.config = Config('https://calls.example.invalid', self.root / 'unused-database')
        self.requests, self.overrides = [], {}
        async def handler(request):
            # Capture only this isolated fixture's credentials for assertions.
            self.requests.append((request.method, request.path, dict(request.query), request.headers.get('Authorization'), await request.read()))
            stage = request.match_info['stage']
            if stage in self.overrides:
                value = self.overrides[stage]
                return await value(request) if callable(value) else value
            if stage in ('synapse_openid', 'public_openid'):
                return web.json_response({'errcode': 'M_UNKNOWN_TOKEN', 'error': 'response-secret-canary'}, status=401)
            if stage in ('issuer_health', 'sfu_health'):
                return web.Response(text='not-a-result-body')
            if stage == 'sfu_credentials':
                return web.json_response({})  # Pinned default LocalStore behavior.
            if stage == 'public_server_discovery':
                return web.json_response({'m.server': 'calls.example.invalid:443'})
            if stage == 'public_client_discovery':
                return web.json_response({'m.homeserver': {'base_url': self.config.public_url}})
            self.fail('Unknown fixture request')
        app = web.Application(); app.router.add_route('*', '/{stage}', handler)
        self.server = TestServer(app); await self.server.start_server()
        self.http = aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar(), trust_env=False)
        test = self
        class Local:
            def request(inner, method, url, **kwargs):
                test.assertFalse(kwargs['allow_redirects'])
                test.assertFalse(kwargs['auto_decompress'])
                test.assertNotIn('ssl', kwargs, 'Never disable TLS verification')
                parsed = urlsplit(url)
                if parsed.hostname == 'synapse': stage = 'synapse_openid'
                elif parsed.hostname == 'rtc-auth': stage = 'issuer_health'
                elif parsed.hostname == 'livekit': stage = 'sfu_credentials' if parsed.path.endswith('/ListParticipants') else 'sfu_health'
                elif parsed.hostname == 'calls.example.invalid':
                    stage = {'/.well-known/matrix/server': 'public_server_discovery', '/.well-known/matrix/client': 'public_client_discovery', '/_matrix/federation/v1/openid/userinfo': 'public_openid'}[parsed.path]
                else: test.fail('A remote/discovered destination was requested')
                return test.http.request(method, test.server.make_url('/' + stage), **kwargs)
        self.local = Local()

    async def asyncTearDown(self):
        await self.http.close(); await self.server.close(); self.env.stop(); self.temp.cleanup()

    async def diagnose(self, **kwargs):
        values = await doctor.diagnose(self.config, self.local, **kwargs)
        output = json.dumps(values)
        for secret in (self.key, self.secret, 'response-secret-canary', 'not-a-result-body', 'Bearer ', 'eyJ', self.config.public_url):
            self.assertNotIn(secret, output)
        for value in values:
            self.assertLessEqual(set(value), {'stage', 'status', 'category', 'http_status'})
            self.assertIn(value['stage'], doctor.STAGES)
            self.assertIn(value['category'], doctor.CATEGORIES)
        self.assertFalse(self.config.data_dir.exists(), 'No database/session store may be initialized')
        return {value['stage']: value for value in values}

    async def test_real_http_read_only_probes_and_signed_nonexistent_room_scope(self):
        values = await self.diagnose()
        self.assertEqual(len(values), 4); self.assertTrue(all(row['status'] == 'pass' for row in values.values()))
        self.assertEqual(values['sfu_credentials']['category'], 'credentials_accepted')
        methods = {(method, path) for method, path, *_ in self.requests}
        self.assertEqual(methods, {('GET', '/synapse_openid'), ('GET', '/issuer_health'), ('GET', '/sfu_health'), ('POST', '/sfu_credentials')})
        for method, path, query, authorization, raw in self.requests:
            if path == '/synapse_openid': self.assertEqual(query, {'access_token': doctor.INVALID_TOKEN})
            if path != '/sfu_credentials': self.assertIsNone(authorization); continue
            body = json.loads(raw); self.assertEqual(set(body), {'room'})
            self.assertRegex(body['room'], r'^tavern-diagnostic-[a-f0-9]{32}$')
            token = authorization.removeprefix('Bearer '); header, payload, signature = token.split('.')
            expected = base64.urlsafe_b64encode(hmac.new(self.secret.encode(), (header + '.' + payload).encode(), hashlib.sha256).digest()).decode().rstrip('=')
            self.assertTrue(hmac.compare_digest(signature, expected))
            claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
            self.assertEqual(claims['video'], {'roomAdmin': True, 'room': body['room']})
            self.assertLessEqual(claims['exp'] - claims['nbf'], 65)

    async def test_missing_internal_openid_and_rejected_sfu_credentials_are_distinguishable(self):
        self.overrides['synapse_openid'] = web.json_response({'errcode': 'M_UNRECOGNIZED', 'error': 'response-secret-canary'}, status=404)
        self.overrides['sfu_credentials'] = web.json_response({'code': 'unauthenticated', 'msg': self.secret}, status=401)
        values = await self.diagnose()
        self.assertEqual(values['synapse_openid']['category'], 'not_found')
        self.assertEqual(values['sfu_credentials']['category'], 'unauthorized')
        self.assertEqual(values['issuer_health']['status'], 'pass')
        # LiveKit's authorization middleware can fail before Twirp emits JSON.
        self.overrides['sfu_credentials'] = web.Response(text=self.secret, status=401)
        self.assertEqual((await self.diagnose())['sfu_credentials']['category'], 'unauthorized')

    async def test_not_found_sfu_is_success_but_real_room_data_is_never_displayed(self):
        self.overrides['sfu_credentials'] = web.json_response({'code': 'not_found', 'msg': 'response-secret-canary'}, status=404)
        self.assertEqual((await self.diagnose())['sfu_credentials']['status'], 'pass')
        self.overrides['sfu_credentials'] = web.json_response({'participants': [{'identity': 'response-secret-canary'}]})
        self.assertEqual((await self.diagnose())['sfu_credentials']['category'], 'unexpected_room')

    async def test_public_checks_use_only_configured_origin_and_never_follow_discovery_or_redirects(self):
        values = await self.diagnose(public=True)
        self.assertTrue(all(row['status'] == 'pass' for row in values.values()))
        self.requests.clear()
        self.overrides['public_server_discovery'] = web.json_response({'m.server': 'attacker.invalid:443'})
        self.overrides['public_client_discovery'] = web.Response(status=302, headers={'Location': 'https://attacker.invalid/secret'})
        values = await self.diagnose(public=True)
        self.assertEqual(values['public_server_discovery']['category'], 'discovery_mismatch')
        self.assertEqual(values['public_client_discovery']['category'], 'redirect_blocked')
        self.assertEqual(len(self.requests), 7)
        self.assertEqual(values['public_openid']['category'], 'invalid_token_rejected')

    async def test_disabled_or_unsupported_configuration_never_sends_any_request(self):
        for key, value, category in [('CALLS_ENABLED', 'false', 'calls_disabled'), ('RTC_AUTH_IMAGE', 'other:latest', 'unsupported_issuer')]:
            with patch.dict(os.environ, {key: value}):
                result = await self.diagnose()
                self.assertEqual(result['configuration']['category'], category)
        self.assertFalse(self.requests)

    async def test_missing_credentials_still_probes_health_without_any_signed_request(self):
        (self.root / 'livekit_secret').unlink()
        values = await self.diagnose()
        self.assertEqual(values['sfu_credentials']['category'], 'credentials_unavailable')
        self.assertFalse(any(path == '/sfu_credentials' for _, path, *_ in self.requests))

    async def test_size_malformed_duplicate_and_encoding_bounds_are_sanitized(self):
        for response, category in [(web.Response(body=b'x' * (doctor.MAX_BODY + 1)), 'response_too_large'),
                                   (web.Response(text='{"errcode":"M_UNKNOWN_TOKEN","errcode":"secret"}', status=401), 'invalid_response'),
                                   (web.Response(text='response-secret-canary', status=401), 'invalid_response'),
                                   (web.Response(body=b'secret', headers={'Content-Encoding': 'gzip'}), 'unsupported_encoding')]:
            self.overrides['synapse_openid'] = response
            self.assertEqual((await self.diagnose())['synapse_openid']['category'], category)

    async def test_actual_slow_http_response_obeys_deadline(self):
        async def slow(request):
            await asyncio.sleep(.1)
            return web.Response(text='slow-secret')
        self.overrides['issuer_health'] = slow
        with patch.object(doctor, 'REQUEST_TIMEOUT', .02):
            values = await self.diagnose()
        self.assertEqual(values['issuer_health']['category'], 'timeout')

    async def test_actual_untrusted_tls_is_rejected_without_certificate_or_exception_output(self):
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(x509.oid.NameOID.COMMON_NAME, 'untrusted-fixture')])
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
                .not_valid_after(datetime.now(timezone.utc) + timedelta(minutes=5)).sign(key, hashes.SHA256()))
        cert_path, key_path = self.root / 'fixture-cert.pem', self.root / 'fixture-key.pem'
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(cert_path, key_path)
        app = web.Application()
        async def health(request): return web.Response(text='healthy')
        app.router.add_get('/healthz', health)
        server = TestServer(app, scheme='https')
        await server.start_server(ssl=tls)
        try:
            value = await doctor.probe(self.http, 'issuer_health', str(server.make_url('/healthz')))
            self.assertEqual(value, {'stage': 'issuer_health', 'status': 'fail', 'category': 'tls_error'})
        finally:
            await server.close()

    async def test_invalid_configured_urls_fail_before_sending_credentials(self):
        for url in ('http://calls.example.invalid', 'https://user:pass@calls.example.invalid', 'https://calls.example.invalid/path', 'https://calls.example.invalid:bad'):
            self.config.public_url = url
            values = await self.diagnose(public=True)
            self.assertEqual(values['configuration']['category'], 'invalid_configuration')
        self.assertFalse(self.requests)


class DiagnosticCliTests(unittest.TestCase):
    def test_cli_outputs_only_fixed_results_and_never_initializes_store(self):
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'CALLS_ENABLED': 'false', 'TAVERN_PUBLIC_URL': 'https://calls.example.invalid', 'API_DATA_DIR': str(Path(directory) / 'absent')}), contextlib.redirect_stdout(output):
            with patch('api.server.Store', side_effect=AssertionError('Diagnostic must never create a Store')), patch('logging.disable'):
                self.assertEqual(doctor.main([]), 1)
            self.assertFalse((Path(directory) / 'absent').exists())
        self.assertEqual(json.loads(output.getvalue()), {'stage': 'configuration', 'status': 'fail', 'category': 'calls_disabled'})
