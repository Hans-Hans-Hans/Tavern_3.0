"""Actual HTTP admission tests with managed cookies and native Matrix fixtures."""
import asyncio
import base64
import copy
import hashlib
import hmac
import json
import time
import unittest
from unittest.mock import patch
from urllib.parse import quote

from aiohttp import ClientConnectionError, web
from aiohttp.test_utils import TestServer

from api.call_moderation import room_alias
from api.rtc_gateway import RtcGateway, decode_jwt, modern_identity
from api.server import APIError, COOKIE
from tests import test_api as account_fixture

KEY, SECRET = 'fixture-api-key', 'fixture-signing-secret-' * 3
ROOM = '!room:test'
ORIGIN = account_fixture.ORIGIN


def signed(subject, room=ROOM, **updates):
    now = int(time.time())
    claims = {'iss': KEY, 'sub': subject, 'nbf': now - 1, 'exp': now + 600,
              'video': {'roomJoin': True, 'room': room_alias(room), 'canPublish': True, 'canSubscribe': True}, **updates}
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).decode().rstrip('=')
    message = encode({'alg': 'HS256', 'typ': 'JWT'}) + '.' + encode(claims)
    signature = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), message.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return message + '.' + signature


class RtcGatewayTests(unittest.IsolatedAsyncioTestCase):
    request = account_fixture.AccountAPITests.request
    login = account_fixture.AccountAPITests.login

    async def asyncSetUp(self):
        await account_fixture.AccountAPITests.asyncSetUp(self)
        for user in self.users.values():
            user.update(is_guest=False, locked=False, suspended=False)
        self.gateway = self.service.rtc_gateway
        self.gateway.moderator.credentials = lambda: (KEY, SECRET)
        self.issuer_calls = []
        self.issuer_hook = self.native_hook = None
        self.openid_subject = '@alice:test'
        self.issuer_result = None
        self.issuer_status = 200
        self.participants = []
        self.sfu_calls = []
        self.sfu_hook = None

        async def native(request, payload):
            if self.native_hook:
                response = await self.native_hook(request, payload)
                if response is not None:
                    return response
            if request.path == '/_matrix/federation/v1/openid/userinfo':
                if request.query.get('access_token') != 'fixture-openid-token':
                    return web.json_response({}, status=401)
                return web.json_response({'sub': self.openid_subject})
            identity = self.tokens.get(request.headers.get('Authorization', '').removeprefix('Bearer '))
            if identity and request.path == '/_matrix/client/v3/account/whoami':
                return web.json_response({'user_id': identity[0], 'device_id': identity[1]})
            if identity and request.path == '/_synapse/admin/v1/rooms/' + ROOM + '/state':
                room = self.rooms[ROOM]
                return web.json_response({'state': [
                    {'type': 'm.room.create', 'state_key': '', 'sender': '@owner:test', 'content': {'m.federate': False}},
                    {'type': 'm.room.encryption', 'state_key': '', 'content': {'algorithm': 'm.megolm.v1.aes-sha2'}},
                    {'type': 'm.room.power_levels', 'state_key': '', 'content': room['powers']},
                    *[{'type': 'm.room.member', 'state_key': user, 'content': {'membership': membership}} for user, membership in room['members'].items()]]})
            return None
        self.upstream_response = native
        self.owner_cookie, _, _ = await self.login('owner')
        self.cookie, self.profile, _ = await self.login()
        self.session = dict(self.service.store.db.execute('SELECT * FROM sessions WHERE user_id=?', ('@alice:test',)).fetchone())
        self.body = {'room_id': ROOM, 'slot_id': 'm.call#ROOM', 'member': {
            'id': 'fixture-member', 'claimed_user_id': '@alice:test', 'claimed_device_id': self.profile['deviceId']},
            'openid_token': {'access_token': 'fixture-openid-token', 'token_type': 'Bearer', 'matrix_server_name': 'test', 'expires_in': 3600}}
        self.identity = modern_identity('@alice:test', self.profile['deviceId'], 'fixture-member')

        async def issuer(request):
            value = await request.json()
            self.issuer_calls.append((request.path, value))
            if self.issuer_hook:
                await self.issuer_hook()
            if self.issuer_result is not None:
                return web.json_response(self.issuer_result, status=self.issuer_status)
            if request.path == '/sfu/get':
                identity = '@alice:test:' + value['device_id']
            else:
                member = value['member']
                identity = modern_identity(member['claimed_user_id'], member['claimed_device_id'], member['id'])
            return web.json_response({'url': ORIGIN.replace('https:', 'wss:') + '/livekit/sfu', 'jwt': signed(identity)})
        app = web.Application()
        app.router.add_post('/{path:.*}', issuer)
        self.issuer = TestServer(app)
        await self.issuer.start_server()
        original = self.gateway.json_request
        async def routed(method, url, **kwargs):
            # Preserve the production HTTP parser/limits; only substitute the
            # deployment-controlled issuer hostname with the local test server.
            if url.startswith('http://rtc-auth:8080/'):
                url = str(self.issuer.make_url(url.removeprefix('http://rtc-auth:8080')))
            return await original(method, url, **kwargs)
        self.gateway.json_request = routed

        async def sfu(method, alias, values=None):
            self.sfu_calls.append((method, alias, values))
            if self.sfu_hook:
                await self.sfu_hook(method)
            if method == 'ListParticipants':
                return {'participants': copy.deepcopy(self.participants)}
            self.participants = [value for value in self.participants if value['identity'] != values['identity']]
            return {}
        self.gateway.moderator.sfu = sfu

    async def asyncTearDown(self):
        if hasattr(self, 'issuer'):
            await self.issuer.close()
        await account_fixture.AccountAPITests.asyncTearDown(self)

    async def token(self, body=None, method='get_token', cookie=None):
        return await self.request('POST', '/api/calls/rtc-auth/' + method, self.body if body is None else body, cookie or self.cookie)

    async def mint(self):
        response = await self.token()
        self.assertEqual(response.status, 200, await response.text())
        return (await response.json())['jwt']

    async def authorize(self, token, path='/livekit/sfu/rtc', cookie=None, **headers):
        return await self.client.get('/api/calls/sfu-authorize', headers={
            'Cookie': COOKIE + '=' + (cookie or self.cookie), 'Origin': ORIGIN,
            'X-Tavern-RTC-Method': 'GET', 'X-Tavern-RTC-URI': path + '?access_token=' + quote(token, safe=''), **headers})

    def rows(self):
        return self.service.store.db.execute('SELECT * FROM rtc_admissions').fetchall()

    async def due(self):
        self.service.store.db.execute('UPDATE rtc_admissions SET next_check=0')
        await self.gateway.sweep()

    async def test_actual_modern_http_and_legacy_protocol_issue_exact_scopes_without_storing_secrets(self):
        token = await self.mint()
        self.assertEqual(decode_jwt(token, KEY, SECRET)['sub'], self.identity)
        self.assertEqual((await self.authorize(token)).status, 204)
        legacy = {'room': ROOM, 'device_id': self.profile['deviceId'], 'openid_token': self.body['openid_token']}
        response = await self.token(legacy, 'sfu/get')
        self.assertEqual(response.status, 200, await response.text())
        legacy_token = (await response.json())['jwt']
        self.assertEqual((await self.authorize(legacy_token, '/livekit/sfu/rtc/v1/validate')).status, 204)
        stored = json.dumps([dict(row) for row in self.rows()])
        for secret in (token, legacy_token, 'fixture-openid-token', SECRET):
            self.assertNotIn(secret, stored)
        self.assertEqual([path for path, _ in self.issuer_calls], ['/get_token', '/sfu/get'])

    async def test_refreshed_signed_token_works_only_with_its_recorded_session_and_scope(self):
        await self.mint()
        refreshed = signed(self.identity, exp=int(time.time()) + 3600, jti='sfu-refresh')
        self.assertEqual((await self.authorize(refreshed)).status, 204)
        self.assertEqual((await self.authorize(refreshed, cookie=self.owner_cookie)).status, 403)
        self.assertEqual((await self.authorize(signed(self.identity, room='!other:test'))).status, 403)
        self.assertEqual((await self.authorize(signed('unrecorded-identity'))).status, 403)
        self.assertEqual(len(self.gateway.locks), 0)

    async def test_wrong_openid_subject_device_homeserver_and_slot_never_reach_issuer(self):
        for key, value in [('claimed_user_id', '@owner:test'), ('claimed_device_id', 'ANOTHER')]:
            body = copy.deepcopy(self.body); body['member'][key] = value
            self.assertEqual((await self.token(body)).status, 403)
        for field, value in [('matrix_server_name', 'attacker.invalid'), ('token_type', 'Basic')]:
            body = copy.deepcopy(self.body); body['openid_token'][field] = value
            self.assertEqual((await self.token(body)).status, 403)
        body = copy.deepcopy(self.body); body['slot_id'] = 'another-call'
        self.assertEqual((await self.token(body)).status, 403)
        self.openid_subject = '@owner:test'
        self.assertEqual((await self.token()).status, 403)
        self.assertEqual(self.issuer_calls, [])

    async def test_native_whoami_must_prove_exact_managed_device(self):
        async def wrong(request, _):
            if request.path.endswith('/account/whoami'):
                return web.json_response({'user_id': '@alice:test', 'device_id': 'ANOTHER'})
        self.native_hook = wrong
        self.assertEqual((await self.token()).status, 403)
        self.assertEqual(self.issuer_calls, [])

    async def test_native_suspension_blocks_new_and_cached_tokens_without_optional_policy(self):
        self.users['@alice:test']['suspended'] = True
        self.assertEqual((await self.token()).status, 403)
        self.assertEqual(self.issuer_calls, [])
        self.assertEqual(self.rows(), [])
        self.users['@alice:test']['suspended'] = False
        token = await self.mint()
        self.assertEqual((await self.authorize(token)).status, 204)
        self.participants = [{'identity': self.identity}, {'identity': 'another-participant'}]
        self.users['@alice:test']['suspended'] = True
        # whoami remains valid on native suspended accounts; the separate
        # current native availability check must reject their signed SFU JWT.
        self.assertEqual((await self.authorize(token)).status, 403)
        await self.due()
        self.assertEqual(self.participants, [{'identity': 'another-participant'}])
        self.assertEqual(self.rows(), [])

    async def test_native_room_and_power_denials_precede_token_issuance(self):
        self.rooms[ROOM]['members']['@alice:test'] = 'leave'
        self.assertEqual((await self.token()).status, 403)
        self.rooms[ROOM]['members']['@alice:test'] = 'join'
        self.rooms[ROOM]['powers']['state_default'] = 100
        self.assertEqual((await self.token()).status, 403)
        self.assertEqual(self.issuer_calls, [])

    async def test_session_revoked_while_request_body_streams_cannot_issue_token(self):
        began, release = asyncio.Event(), asyncio.Event()
        async def body():
            yield b'{'
            began.set()
            await release.wait()
            yield json.dumps(self.body).encode()[1:]
        task = asyncio.create_task(self.client.post('/api/calls/rtc-auth/get_token', data=body(), headers={
            'Cookie': COOKIE + '=' + self.cookie, 'Origin': ORIGIN, 'Content-Type': 'application/json'}))
        await began.wait(); await asyncio.sleep(0)
        self.service.store.db.execute('DELETE FROM sessions WHERE id=?', (self.session['id'],))
        release.set()
        self.assertEqual((await task).status, 401)
        self.assertEqual(self.issuer_calls, [])

    async def test_session_revoked_or_native_membership_lost_during_issuer_wait_is_never_published(self):
        async def revoke():
            self.service.store.db.execute('DELETE FROM sessions WHERE id=?', (self.session['id'],))
        self.issuer_hook = revoke
        response = await self.token()
        self.assertEqual(response.status, 401)
        self.assertNotIn('jwt', await response.text())
        self.assertEqual(self.rows(), [])

    async def test_membership_lost_during_issuer_wait_is_never_published(self):
        async def leave():
            self.rooms[ROOM]['members']['@alice:test'] = 'leave'
        self.issuer_hook = leave
        self.assertEqual((await self.token()).status, 403)
        self.assertEqual(self.rows(), [])

    async def test_unexpected_issuer_scope_url_and_malformed_payload_do_not_reflect_tokens(self):
        for value in ({'url': ORIGIN.replace('https:', 'wss:') + '/livekit/sfu', 'jwt': signed('another-user')},
                      {'url': 'wss://other.invalid', 'jwt': signed(self.identity)}, ['not an object']):
            self.issuer_result = value
            response = await self.token()
            self.assertEqual(response.status, 503)
            self.assertNotIn('jwt', await response.text())
            self.assertEqual(self.rows(), [])

    async def test_private_issuer_urls_return_only_the_public_authenticated_signaling_url(self):
        for method in ('get_token', 'sfu/get'):
            body = self.body if method == 'get_token' else {'room': ROOM, 'device_id': self.profile['deviceId'], 'openid_token': self.body['openid_token']}
            subject = self.identity if method == 'get_token' else '@alice:test:' + self.profile['deviceId']
            for url in ('http://livekit:7880', 'ws://livekit:7880'):
                self.issuer_result = {'url': url, 'jwt': signed(subject)}
                response = await self.token(body, method)
                self.assertEqual(response.status, 200, await response.text())
                result = await response.json()
                self.assertEqual(result['url'], ORIGIN.replace('https:', 'wss:') + '/livekit/sfu')
                self.assertEqual(decode_jwt(result['jwt'], KEY, SECRET)['sub'], subject)
                self.assertEqual((await self.authorize(result['jwt'])).status, 204)

    async def test_internal_url_allowlist_does_not_accept_redirects_credentials_or_foreign_scopes(self):
        for url in ('http://livekit:7880/', 'http://livekit:7880/rtc', 'http://livekit:7881',
                    'http://livekit:7880?token=secret', 'http://livekit:7880#fragment',
                    'http://user:password@livekit:7880', 'http://livekit.evil.invalid:7880',
                    None, [], {}, 7880):
            self.issuer_result = {'url': url, 'jwt': signed(self.identity)}
            response = await self.token()
            self.assertEqual(response.status, 503)
            text = await response.text()
            if isinstance(url, str):
                self.assertNotIn(url, text)
            self.assertEqual(self.rows(), [])
        self.issuer_result = {'url': 'http://livekit:7880', 'jwt': signed('foreign-device')}
        self.assertEqual((await self.token()).status, 503)
        self.assertEqual(self.rows(), [])

    async def test_native_openid_404_is_distinguished_without_reflecting_upstream_payload(self):
        async def missing(request, payload):
            if request.path.endswith('/openid/userinfo'):
                return web.Response(text='private-upstream-detail', status=404)
        self.native_hook = missing
        with self.assertLogs('tavern.api.rtc', level='WARNING') as logs:
            response = await self.token()
        self.assertEqual(response.status, 503)
        body = await response.json()
        self.assertEqual(body['errcode'], 'CALL_OPENID_UNAVAILABLE')
        self.assertIn('HTTP 404', body['error'])
        self.assertEqual(self.issuer_calls, [])
        self.assertNotIn('fixture-openid-token', str(logs.output))
        self.assertNotIn('private-upstream-detail', str(logs.output) + str(body))

    async def test_issuer_room_creation_and_openid_errors_have_safe_distinct_diagnostics(self):
        for status, value, code in (
            (500, {'errcode': 'M_UNKNOWN', 'error': 'Unable to create room on SFU'}, 'CALL_SFU_ROOM_CREATION_FAILED'),
            (401, {'errcode': 'M_UNAUTHORIZED', 'error': 'private-token-or-query'}, 'CALL_ISSUER_OPENID_REJECTED'),
            (500, {'errcode': 'private-token-or-query', 'error': 'private-token-or-query'}, 'CALL_ISSUER_UNAVAILABLE'),
        ):
            self.issuer_status, self.issuer_result = status, value
            with self.assertLogs('tavern.api.rtc', level='WARNING') as logs:
                response = await self.token()
            body = await response.json()
            self.assertEqual(response.status, 403 if status == 401 else 503)
            self.assertEqual(body['errcode'], code)
            self.assertEqual(self.rows(), [])
            self.assertNotIn('private-token-or-query', str(logs.output) + str(body))
            self.assertNotIn('fixture-openid-token', str(logs.output) + str(body))

    async def test_origin_alternate_routes_duplicate_and_conflicting_token_sources_are_denied(self):
        token = await self.mint()
        for headers in ({'Origin': 'https://evil.invalid'}, {'X-Tavern-RTC-Method': 'POST'},
                        {'Authorization': 'Bearer ' + token},
                        {'X-Tavern-RTC-URI': '/livekit/sfu/rtc?access_token=' + token + '&publish=untracked-device'},
                        {'X-Tavern-RTC-URI': '/livekit/sfu/rtc?access_token=' + token + '&access_token=' + token}):
            self.assertEqual((await self.authorize(token, **headers)).status, 403)
        for path in ('/livekit/sfu/twirp/livekit.RoomService/ListParticipants', '/livekit/sfu/rtc/other'):
            self.assertEqual((await self.authorize(token, path)).status, 403)

    async def test_cookie_session_and_native_token_revocation_block_cached_sfu_tokens(self):
        token = await self.mint()
        self.tokens.pop(self.service.store.open(self.session['token']))
        self.assertEqual((await self.authorize(token)).status, 401)
        self.service.store.db.execute('DELETE FROM sessions WHERE id=?', (self.session['id'],))
        self.assertEqual((await self.authorize(token)).status, 401)

    async def test_known_revoked_session_disconnects_only_its_proven_identity_and_confirms_inventory(self):
        token = await self.mint()
        await self.authorize(token)
        self.participants = [{'identity': self.identity}, {'identity': 'another-participant'}]
        self.service.store.db.execute('DELETE FROM sessions WHERE id=?', (self.session['id'],))
        await self.due()
        self.assertEqual(self.participants, [{'identity': 'another-participant'}])
        self.assertEqual(self.rows(), [])
        self.assertEqual([call[0] for call in self.sfu_calls], ['RemoveParticipant', 'ListParticipants'])

    async def test_permission_loss_during_sfu_inventory_is_rechecked_before_retaining_call(self):
        await self.mint()
        self.participants = [{'identity': self.identity}]
        async def change(method):
            if method == 'ListParticipants':
                self.rooms[ROOM]['members']['@alice:test'] = 'leave'
        self.sfu_hook = change
        await self.due()
        self.assertEqual(self.participants, [])
        self.assertEqual(self.rows(), [])

    async def test_native_authority_outage_fails_closed_for_existing_proven_call(self):
        await self.mint()
        self.participants = [{'identity': self.identity}]
        async def unavailable(*_):
            raise ClientConnectionError('sensitive upstream details must not be logged')
        with patch('api.rtc_gateway.call_authority', unavailable):
            await self.due()
        self.assertEqual(self.participants, [])

    async def test_sfu_failure_retains_durable_retry_without_success_or_audit_flood(self):
        await self.mint()
        self.participants = [{'identity': self.identity}]
        self.service.store.db.execute('DELETE FROM sessions WHERE id=?', (self.session['id'],))
        async def unavailable(method):
            if method == 'RemoveParticipant':
                raise APIError(503, 'Unavailable')
        self.sfu_hook = unavailable
        await self.due(); await self.due()
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.service.store.db.execute("SELECT count(*) FROM audit WHERE action='call.access_check_pending'").fetchone()[0], 1)
        self.assertEqual(self.service.store.db.execute("SELECT count(*) FROM audit WHERE action='call.access_revoked'").fetchone()[0], 0)
        # Process restart keeps only scope metadata; retry still targets exactly
        # the original proven identity and never invents participant ownership.
        self.gateway = RtcGateway(self.service)
        self.gateway.moderator.credentials = lambda: (KEY, SECRET)
        async def recovered(method, alias, values=None):
            if method == 'RemoveParticipant': self.participants = []
            return {'participants': self.participants}
        self.gateway.moderator.sfu = recovered
        await self.due()
        self.assertEqual(self.rows(), [])

    async def test_capacity_is_bounded_and_completed_identity_locks_are_released(self):
        with patch('api.rtc_gateway.MAX_ADMISSIONS', 1):
            await self.mint()
            body = copy.deepcopy(self.body); body['member']['id'] = 'another-member'
            self.assertEqual((await self.token(body)).status, 503)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(len(self.gateway.locks), 0)

    async def test_signaling_session_revoked_during_native_authority_await_is_denied(self):
        token = await self.mint()
        async def revoke(request, _):
            if request.path.startswith('/_synapse/admin/v1/rooms/'):
                self.service.store.db.execute('DELETE FROM sessions WHERE id=?', (self.session['id'],))
        self.native_hook = revoke
        self.assertEqual((await self.authorize(token)).status, 401)
        self.assertEqual(self.rows()[0]['admitted'], 0)

    async def test_reconciliation_parallelism_is_bounded_without_skipping_due_rows(self):
        await self.mint()
        db = self.service.store.db
        original = dict(self.rows()[0])
        for index in range(18):
            row = {**original, 'identity': 'fixture-scope-' + str(index)}
            db.execute('INSERT INTO rtc_admissions(' + ','.join(row) + ') VALUES(' + ','.join('?' for _ in row) + ')', tuple(row.values()))
        started, release = asyncio.Event(), asyncio.Event()
        active, peak, seen = 0, 0, []
        async def check(row):
            nonlocal active, peak
            active += 1; peak = max(peak, active); seen.append(row['identity'])
            if active == 8: started.set()
            await release.wait()
            active -= 1
        self.gateway.check_lease = check
        task = asyncio.create_task(self.gateway.sweep())
        await asyncio.wait_for(started.wait(), 1)
        self.assertEqual(peak, 8)
        release.set(); await task
        self.assertEqual(len(set(seen)), 19)
        self.assertEqual(peak, 8)

    async def test_auth_request_does_not_rotate_cookie_but_normal_session_request_does(self):
        token = await self.mint()
        db = self.service.store.db
        db.execute('UPDATE sessions SET rotated=? WHERE id=?', (time.time() - 901, self.session['id']))
        response = await self.authorize(token)
        self.assertEqual(response.status, 204)
        self.assertNotIn('Set-Cookie', response.headers)
        self.assertEqual(db.execute('SELECT cookie_hash FROM sessions WHERE id=?', (self.session['id'],)).fetchone()[0], self.service.store.digest(self.cookie))
        ordinary = await self.request('GET', '/api/auth/session', cookie=self.cookie)
        self.assertEqual(ordinary.status, 200)
        self.assertIn('Set-Cookie', ordinary.headers)
        self.assertNotEqual(db.execute('SELECT cookie_hash FROM sessions WHERE id=?', (self.session['id'],)).fetchone()[0], self.service.store.digest(self.cookie))

    async def test_delay_delegation_preserves_compatible_body_and_rejects_arbitrary_discovery_url(self):
        value = {**self.body, 'delay_id': 'fixture-delay-capability', 'delay_timeout': 8000, 'delay_cs_api_url': ORIGIN + '/api/matrix'}
        response = await self.token(value)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.issuer_calls[0][1], value)
        value['delay_cs_api_url'] = 'https://attacker.invalid'
        self.assertEqual((await self.token(value)).status, 403)
        self.assertEqual(len(self.issuer_calls), 1)
        self.assertNotIn('fixture-delay-capability', json.dumps([dict(row) for row in self.rows()]))


class RtcJwtTests(unittest.TestCase):
    def test_signature_expiry_issuer_native_privilege_and_malformed_claims_fail_closed(self):
        token = signed('fixture')
        for value in (token[:-8] + 'tampered', signed('fixture', exp=int(time.time()) - 1),
                      signed('fixture', iss='another-key'), signed('fixture', nbf=True),
                      signed('fixture', video={'roomJoin': True, 'roomAdmin': True, 'room': 'one'}), 'not-a-jwt'):
            with self.assertRaises(APIError) as result:
                decode_jwt(value, KEY, SECRET)
            self.assertNotIn(value, result.exception.message)


if __name__ == '__main__': unittest.main()
