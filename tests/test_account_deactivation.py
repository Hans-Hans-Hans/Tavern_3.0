import asyncio
import json
import re
import time
import unittest
from unittest.mock import AsyncMock

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from api.server import APIError, COOKIE, create_app
from api.security import totp_setup
from tests import test_api_admin_users as fixture
from tests import test_api as http_fixture


class DeactivationTests(unittest.IsolatedAsyncioTestCase):
    request = fixture.AdminUserTests.request
    login = fixture.AdminUserTests.login
    action = fixture.AdminUserTests.action
    asyncTearDown = fixture.AdminUserTests.asyncTearDown

    async def asyncSetUp(self):
        await fixture.AdminUserTests.asyncSetUp(self)
        for user in self.users.values():
            user['deactivated'] = False
        self.owner, _, _ = await self.login('owner')
        self.alice, _, _ = await self.login()
        original = self.service.uia
        async def native(session, path, body, password):
            result = await original(session, path, body, password)
            if path.endswith('/deactivate'):
                self.users[session['user_id']]['deactivated'] = True
            return result
        self.service.uia = native

    async def delete(self, **extra):
        return await self.request('POST', '/api/account/deactivate', {'password': 'Correct password!', 'confirmation': '@alice:test', 'erase': True, **extra}, self.alice)

    def seed_personal_state(self):
        db = self.service.store.db
        db.execute("UPDATE accounts SET email='alice@example.test',verified=1,timezone='Europe/Paris' WHERE user_id='@alice:test'")
        db.execute("INSERT INTO social_preferences VALUES('@alice:test','nobody')")
        db.execute("INSERT INTO social_friend_codes VALUES('@alice:test','123456789ABC',1)")
        db.execute("INSERT INTO social_requests VALUES('contact','@alice:test','@owner:test','accepted',1,1)")
        db.execute("INSERT INTO social_requests VALUES('unrelated','@other:test','@owner:test','accepted',1,1)")
        db.execute("INSERT INTO social_blocks VALUES('@alice:test','@owner:test',1)")
        db.execute("INSERT INTO social_blocks VALUES('@owner:test','@alice:test',1)")
        db.execute("INSERT INTO invitations(id,token_hash,room_id,room_name,creator,created,expires,max_uses,uses,email,splash_mxc) VALUES('own','own-token','!room:test','Room','@alice:test',1,9999999999,2,1,'recipient@example.test','mxc://test/splash')")
        db.execute("INSERT INTO invitations(id,token_hash,room_id,room_name,creator,created,expires,max_uses,uses,email) VALUES('received','received-token','!room:test','Room','@owner:test',1,9999999999,1,1,'alice@example.test')")
        db.execute("INSERT INTO invitation_redemptions VALUES('received','@alice:test','joined',1)")
        db.execute("INSERT INTO upload_usage VALUES('@alice:test',90)")
        db.execute("INSERT INTO upload_usage VALUES('*',90)")
        db.execute("INSERT INTO upload_reservations VALUES('stored','@alice:test',50,'stored',1,'mxc://test/file')")
        db.execute("INSERT INTO upload_reservations VALUES('uncertain','@alice:test',40,'reserved',1,NULL)")
        db.execute("INSERT INTO reports(reporter,kind,reason,evidence,created,updated) VALUES('@alice:test','user','safety report','explicitly supplied evidence',1,1)")
        db.execute("INSERT INTO moderation_warnings(room_id,target,actor,reason,created) VALUES('!room:test','@alice:test','@owner:test','moderation record',1)")
        self.service.new_recovery_codes('@alice:test')
        self.service.store.challenge('login', {'login': {'access_token': 'not-a-new-secret'}}, '@alice:test')

    async def test_confirmed_cleanup_is_atomic_scoped_and_does_not_refund_media_or_invites(self):
        self.seed_personal_state()
        notified = asyncio.Queue(maxsize=1)
        self.app['social_watchers']['@owner:test'] = {notified}
        response = await self.delete()
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual(result['deactivation']['phase'], 'complete')
        db = self.service.store.db
        for table in ('accounts', 'sessions', 'challenges', 'recovery_codes', 'social_preferences', 'social_friend_codes', 'invitation_redemptions'):
            self.assertEqual(db.execute('SELECT count(*) FROM ' + table + ' WHERE user_id=?', ('@alice:test',)).fetchone()[0], 0, table)
        self.assertEqual([row[0] for row in db.execute('SELECT id FROM social_requests')], ['unrelated'])
        self.assertEqual([tuple(row)[:2] for row in db.execute('SELECT * FROM social_blocks')], [('@owner:test', '@alice:test')])
        self.assertEqual([tuple(row) for row in db.execute('SELECT id,revoked,email,uses FROM invitations ORDER BY id')], [('own', 1, None, 1), ('received', 1, None, 1)])
        self.assertEqual(db.execute("SELECT bytes FROM upload_usage WHERE user_id='*'").fetchone()[0], 90)
        self.assertEqual([row[0] for row in db.execute('SELECT id FROM upload_reservations')], ['uncertain'])
        self.assertEqual(db.execute('SELECT count(*) FROM reports').fetchone()[0], 1)
        self.assertEqual(db.execute('SELECT count(*) FROM moderation_warnings').fetchone()[0], 1)
        self.assertFalse(notified.empty())
        self.service.deactivations.cleanup(result['deactivation']['id'])
        self.assertEqual(db.execute("SELECT count(*) FROM audit WHERE action='account_deactivated'").fetchone()[0], 1)
        self.assertEqual((await self.request('GET', '/api/social', cookie=self.alice)).status, 401)
        self.assertIn('Max-Age=0', response.headers['Set-Cookie'])
        record = json.dumps(dict(db.execute('SELECT * FROM account_deactivations').fetchone()))
        for secret in ('Correct password!', 'real-secret', '@example', 'alice@example.test', 'not-a-new-secret'):
            self.assertNotIn(secret, record)

    async def test_password_factor_confirmation_admin_and_injected_modes_never_start_journal(self):
        for extra in ({'confirmation': 'DELETE'}, {'password': 'wrong'}, {'userId': '@owner:test'}, {'historyPolicy': 'delete'}, {'erase': 'yes'}):
            self.assertGreaterEqual((await self.delete(**extra)).status, 400)
        secret, _ = totp_setup('@alice:test')
        self.service.store.db.execute("UPDATE accounts SET totp=? WHERE user_id='@alice:test'", (self.service.store.seal(secret),))
        self.assertEqual((await self.delete(code='invalid')).status, 400)
        self.assertEqual((await self.request('POST', '/api/account/deactivate', {'password': 'Correct password!', 'confirmation': '@owner:test'}, self.owner)).status, 400)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM account_deactivations').fetchone()[0], 0)

    async def test_lost_response_is_reconciled_from_native_account_not_token_invalidity(self):
        async def lost(session, *args):
            self.users[session['user_id']]['deactivated'] = True
            raise aiohttp.ClientConnectionError('secret transport detail')
        self.service.uia = lost
        response = await self.delete()
        self.assertEqual(response.status, 200, await response.text())
        self.assertFalse(self.service.store.account('@alice:test'))
        self.assertEqual(self.service.deactivations.view('@alice:test')['phase'], 'complete')

    async def test_unconfirmed_native_account_stays_locked_and_retries_do_not_repeat_deactivation(self):
        self.service.uia = AsyncMock(side_effect=APIError(401, 'not proof of deactivation', 'M_UNKNOWN_TOKEN'))
        response = await self.delete()
        self.assertEqual(response.status, 202, await response.text())
        result = await response.json()
        self.assertFalse(result['ok']); self.assertEqual(result['deactivation']['phase'], 'pending')
        self.assertEqual(self.service.deactivations.view('@alice:test')['issue'], 'native_account_active')
        self.assertTrue(self.service.store.account('@alice:test'))
        retry = await self.delete()
        self.assertEqual(retry.status, 401)
        self.assertEqual(self.service.uia.await_count, 1)
        login = await self.request('POST', '/api/auth/login', {'username': 'alice', 'password': 'Correct password!'})
        self.assertEqual(login.status, 403)
        # A privileged PUT profile route and explicit enable cannot remove this gate.
        update = await self.request('PUT', '/api/admin/users/@alice:test', {'locked': False, 'confirmation': '@alice:test'}, self.owner)
        self.assertEqual(update.status, 403)
        self.assertEqual((await self.action(self.owner, 'enable')).status, 403)
        peer = await self.request('POST', '/api/social/requests', {'target': '@alice:test'}, self.owner)
        self.assertEqual(peer.status, 400)
        self.assertNotIn(result['deactivation']['id'], await peer.text())
        detail = await self.request('GET', '/api/admin/users/@alice:test', cookie=self.owner)
        self.assertEqual((await detail.json())['deactivation']['id'], result['deactivation']['id'])

    async def test_restart_recovers_late_native_success_with_no_saved_credentials(self):
        self.service.uia = AsyncMock(side_effect=aiohttp.ClientConnectionError())
        response = await self.delete()
        identity = (await response.json())['deactivation']['id']
        await self.client.close()
        self.users['@alice:test']['deactivated'] = True
        self.app = create_app(self.config)
        self.service = self.app['service']
        async def native(method, path, body=None, token=None, expected=True):
            self.assertEqual(method, 'GET')
            self.assertTrue(path.endswith('%40alice%3Atest'))
            return 200, {'name': '@alice:test', 'deactivated': True}
        self.service.matrix = native
        self.service.store.db.execute('UPDATE account_deactivations SET next_check=0 WHERE id=?', (identity,))
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        for _ in range(30):
            if self.service.deactivations.view('@alice:test')['phase'] == 'complete': break
            await asyncio.sleep(.01)
        self.assertEqual(self.service.deactivations.view('@alice:test')['phase'], 'complete')
        self.assertFalse(self.service.store.account('@alice:test'))

    async def test_cleanup_failure_rolls_back_personal_state_then_recovers_once(self):
        self.seed_personal_state()
        db = self.service.store.db
        db.executescript("CREATE TRIGGER fail_deactivation BEFORE DELETE ON accounts WHEN OLD.user_id='@alice:test' BEGIN SELECT RAISE(FAIL,'test interruption'); END;")
        response = await self.delete()
        self.assertEqual(response.status, 202, await response.text())
        row = self.service.deactivations.view('@alice:test')
        self.assertEqual(row['phase'], 'native_confirmed')
        self.assertTrue(db.execute("SELECT 1 FROM social_requests WHERE id='contact'").fetchone())
        self.assertEqual(db.execute("SELECT revoked FROM invitations WHERE id='own'").fetchone()[0], 0)
        db.execute('DROP TRIGGER fail_deactivation')
        await self.service.deactivations.reconcile(row['id'])
        self.assertEqual(self.service.deactivations.view('@alice:test')['phase'], 'complete')
        self.assertEqual(db.execute("SELECT count(*) FROM audit WHERE action='account_deactivated'").fetchone()[0], 1)

    async def test_staff_can_complete_pending_with_original_erase_choice_then_reactivate(self):
        self.service.uia = AsyncMock(side_effect=aiohttp.ClientConnectionError())
        await self.delete()
        result = await self.action(self.owner, 'deactivate')
        self.assertEqual(result.status, 200, await result.text())
        self.assertEqual(self.service.deactivations.view('@alice:test')['phase'], 'complete')
        self.assertFalse(self.service.store.account('@alice:test'))
        self.assertEqual((await self.action(self.owner, 'enable', newPassword='A new strong password!')).status, 200)
        self.assertFalse(self.service.deactivations.unavailable('@alice:test'))

    async def test_stale_social_fetch_cannot_recreate_a_deleted_personal_relationship(self):
        entered, release = asyncio.Event(), asyncio.Event()
        native = self.service.matrix
        async def wait_profile(method, path, body=None, token=None, expected=True):
            result = await native(method, path, body, token, expected)
            if path.endswith('/profile/%40alice%3Atest'):
                entered.set(); await release.wait()
            return result
        self.service.matrix = wait_profile
        pending = asyncio.create_task(self.request('POST', '/api/social/requests', {'target': '@alice:test'}, self.owner))
        await asyncio.wait_for(entered.wait(), 2)
        self.assertEqual((await self.delete()).status, 200)
        release.set()
        self.assertEqual((await pending).status, 400)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM social_requests').fetchone()[0], 0)

    async def test_cancellation_keeps_a_recoverable_journal(self):
        manager = self.service.deactivations
        identity = manager.begin('@alice:test', True)
        self.service.matrix = AsyncMock(side_effect=asyncio.CancelledError())
        with self.assertRaises(asyncio.CancelledError): await manager.reconcile(identity)
        self.assertEqual(manager.view('@alice:test')['phase'], 'pending')
        self.assertTrue(self.service.store.account('@alice:test'))

    async def test_malformed_or_wrong_native_identity_cannot_authorize_cleanup(self):
        manager = self.service.deactivations
        identity = manager.begin('@alice:test', False)
        for response in ((200, {'name': '@owner:test', 'deactivated': True}), (200, {'name': '@alice:test', 'deactivated': 'true'}), (404, {}), (401, {})):
            self.service.matrix = AsyncMock(return_value=response)
            await manager.reconcile(identity)
            self.assertEqual(manager.view('@alice:test')['phase'], 'pending')
            self.assertTrue(self.service.store.account('@alice:test'))
        self.assertGreater(manager.view('@alice:test')['updatedAt'], 0)

    async def test_upload_waiting_for_body_cannot_recreate_removed_quota_identity(self):
        await self.service.uploads.ensure_initialized()
        entered, release = asyncio.Event(), asyncio.Event()
        async def chunks():
            yield b'first encrypted chunk'
            entered.set(); await release.wait()
            yield b'last encrypted chunk'
        row = self.service.store.db.execute('SELECT device_id FROM sessions WHERE cookie_hash=?', (self.service.store.digest(self.alice),)).fetchone()
        request = asyncio.create_task(self.client.post('/api/matrix/_matrix/media/v3/upload', data=chunks(), headers={
            'Origin': self.config.public_url, 'Cookie': COOKIE + '=' + self.alice, 'Authorization': 'Bearer cookie-session:' + row[0], 'Content-Type': 'application/octet-stream'}))
        await asyncio.wait_for(entered.wait(), 2)
        self.assertEqual((await self.delete()).status, 200)
        release.set()
        response = await request
        self.assertEqual(response.status, 401)
        self.assertFalse(any(path.endswith('/upload') for _, path, _, _ in self.upstream_calls))
        self.assertFalse(self.service.store.db.execute("SELECT 1 FROM upload_usage WHERE user_id='@alice:test'").fetchone())

    async def test_unsupported_native_authentication_releases_pending_gate_but_requires_new_session(self):
        self.service.uia = AsyncMock(side_effect=APIError(400, 'Additional native authentication required.', 'UNSUPPORTED_UIA'))
        response = await self.delete()
        self.assertEqual(response.status, 400)
        self.assertTrue((await response.json())['signedOut'])
        self.assertEqual(self.service.deactivations.view('@alice:test')['phase'], 'rejected')
        self.assertFalse(self.service.deactivations.pending('@alice:test'))
        self.assertEqual(self.service.store.account('@alice:test')['access_blocked'], '')
        self.assertEqual((await self.request('GET', '/api/social', cookie=self.alice)).status, 401)
        self.assertEqual((await self.request('POST', '/api/auth/login', {'username': 'alice', 'password': 'Correct password!'})).status, 200)

    async def test_unverified_email_cannot_revoke_another_issuers_invitation(self):
        self.seed_personal_state()
        db = self.service.store.db
        db.execute("UPDATE accounts SET verified=0 WHERE user_id='@alice:test'")
        self.assertEqual((await self.delete()).status, 200)
        received = db.execute("SELECT revoked,email FROM invitations WHERE id='received'").fetchone()
        self.assertEqual(tuple(received), (0, 'alice@example.test'))

    async def test_invalid_admin_status_never_starts_a_destructive_operation(self):
        native = self.service.matrix
        async def invalid(method, path, body=None, token=None, expected=True):
            if path.endswith('/admin'):
                return 200, {'admin': 'false'}
            return await native(method, path, body, token, expected)
        self.service.matrix = invalid
        self.assertEqual((await self.delete()).status, 503)
        self.assertIsNone(self.service.deactivations.view('@alice:test'))


class DeactivationHTTPTests(unittest.IsolatedAsyncioTestCase):
    """Keep real HTTP parsing, Service.matrix and UIA in the regression path."""
    request = http_fixture.AccountAPITests.request
    login = http_fixture.AccountAPITests.login
    action = fixture.AdminUserTests.action
    delete = DeactivationTests.delete
    asyncTearDown = http_fixture.AccountAPITests.asyncTearDown

    async def asyncSetUp(self):
        await http_fixture.AccountAPITests.asyncSetUp(self)
        self.owner, _, _ = await self.login('owner')
        self.alice, _, _ = await self.login()
        self.service.store.db.execute("INSERT INTO social_preferences VALUES('@alice:test','nobody')")

    def assert_pending(self):
        manager = self.service.deactivations
        self.assertEqual(manager.view('@alice:test')['phase'], 'pending')
        self.assertFalse(self.users['@alice:test'].get('deactivated'))
        self.assertTrue(self.service.store.account('@alice:test')['access_blocked'])
        self.assertTrue(self.service.store.db.execute("SELECT 1 FROM social_preferences WHERE user_id='@alice:test'").fetchone())
        self.assertFalse(self.service.store.db.execute("SELECT 1 FROM sessions WHERE user_id='@alice:test'").fetchone())
        self.assertFalse(self.service.store.db.execute("SELECT 1 FROM audit WHERE action='account_deactivated'").fetchone())

    async def malformed_self(self, response, second_leg=False):
        async def upstream(request, payload):
            if request.path == '/_matrix/client/v3/account/deactivate' and (not second_leg or payload.get('auth', {}).get('session')):
                return response()
        self.upstream_response = upstream
        result = await self.delete()
        self.assertEqual(result.status, 202, await result.text())
        self.assertFalse((await result.json())['ok'])
        self.assert_pending()
        self.assertEqual(self.service.deactivations.view('@alice:test')['issue'], 'native_account_active')
        self.assertTrue(any(method == 'GET' and path == '/_synapse/admin/v2/users/@alice:test' for method, path, _, _ in self.upstream_calls))
        attempts = [payload for _, path, payload, _ in self.upstream_calls if path == '/_matrix/client/v3/account/deactivate']
        self.assertEqual(len(attempts), 2 if second_leg else 1)

    async def test_html_http_success_does_not_confirm_deactivation(self):
        await self.malformed_self(lambda: web.Response(text='<html>Proxy maintenance</html>', content_type='text/html'))

    async def test_non_object_http_success_does_not_confirm_deactivation(self):
        await self.malformed_self(lambda: web.json_response(['not a native success response']))

    async def test_malformed_success_after_password_uia_challenge_stays_pending(self):
        await self.malformed_self(lambda: web.Response(text='truncated-json', content_type='application/json'), second_leg=True)

    async def test_even_valid_empty_post_success_needs_native_inactive_status(self):
        await self.malformed_self(lambda: web.json_response({}))

    async def test_staff_retry_only_cleans_up_after_native_status_confirms_success(self):
        async def upstream(request, payload):
            if request.path == '/_matrix/client/v3/account/deactivate':
                return web.Response(status=502)
        self.upstream_response = upstream
        self.assertEqual((await self.delete()).status, 202)
        for malformed in ('html', 'array'):
            async def staff_response(request, payload):
                if request.path.startswith('/_synapse/admin/v1/deactivate/'):
                    self.assertTrue(payload['erase'])
                    return web.Response(text='<html>not Synapse</html>', content_type='text/html') if malformed == 'html' else web.json_response([])
            self.upstream_response = staff_response
            result = await self.action(self.owner, 'deactivate')
            self.assertEqual(result.status, 202, await result.text())
            self.assertFalse((await result.json())['ok'])
            self.assert_pending()
        # The same explicit staff action can finish the durable operation once
        # the real native endpoint applies it; no second journal is created.
        self.upstream_response = None
        result = await self.action(self.owner, 'deactivate')
        self.assertEqual(result.status, 200, await result.text())
        self.assertEqual(self.service.deactivations.view('@alice:test')['phase'], 'complete')
        self.assertFalse(self.service.store.account('@alice:test'))
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM account_deactivations').fetchone()[0], 1)

    async def test_malformed_status_response_after_native_success_defers_cleanup(self):
        async def upstream(request, payload):
            if request.path == '/_synapse/admin/v2/users/@alice:test':
                return web.json_response([{'name': '@alice:test', 'deactivated': True}])
        self.upstream_response = upstream
        result = await self.delete()
        self.assertEqual(result.status, 202, await result.text())
        self.assertTrue(self.users['@alice:test']['deactivated'])
        self.assertEqual(self.service.deactivations.view('@alice:test')['phase'], 'pending')
        self.assertTrue(self.service.store.account('@alice:test'))
        self.upstream_response = None
        await self.service.deactivations.reconcile(self.service.deactivations.view('@alice:test')['id'])
        self.assertEqual(self.service.deactivations.view('@alice:test')['phase'], 'complete')

    async def test_privacy_body_finishing_after_deactivation_cannot_recreate_preferences(self):
        authenticated, release = asyncio.Event(), asyncio.Event()
        require_session = self.service.require_session
        def checked_session(request, *args, **kwargs):
            result = require_session(request, *args, **kwargs)
            if request.path == '/api/social/privacy':
                authenticated.set()
            return result
        self.service.require_session = checked_session
        async def chunks():
            yield b'{"requests":"'
            await release.wait()
            yield b'everyone"}'
        request = asyncio.create_task(self.client.put('/api/social/privacy', data=chunks(), headers={
            'Origin': self.config.public_url, 'Cookie': COOKIE + '=' + self.alice, 'Content-Type': 'application/json'}))
        try:
            await asyncio.wait_for(authenticated.wait(), 2)
            result = await self.delete()
            self.assertEqual(result.status, 200, await result.text())
        finally:
            release.set()
        response = await asyncio.wait_for(request, 2)
        self.assertEqual(response.status, 401, await response.text())
        self.assertFalse(self.service.store.db.execute("SELECT 1 FROM social_preferences WHERE user_id='@alice:test'").fetchone())
        self.assertFalse(self.service.store.account('@alice:test'))

    async def invitation_race(self, stage):
        created = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'maxUses': 1}, self.owner)
        self.assertEqual(created.status, 201, await created.text())
        invitation = await created.json()
        entered, release = asyncio.Event(), asyncio.Event()
        async def upstream(request, payload):
            match = request.path == '/_synapse/admin/v1/rooms/!room:test/state' if stage == 'authority' else request.path == '/_synapse/admin/v1/users/@owner:test/login'
            if match and not entered.is_set():
                entered.set()
                await release.wait()
        self.upstream_response = upstream
        pending = asyncio.create_task(self.request('POST', '/api/invitations/redeem', {'token': invitation['token']}, self.alice))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            result = await self.delete()
            self.assertEqual(result.status, 200, await result.text())
        finally:
            release.set()
        result = await asyncio.wait_for(pending, 2)
        self.assertEqual(result.status, 401, await result.text())
        self.assertFalse(self.service.store.db.execute("SELECT 1 FROM invitation_redemptions WHERE user_id='@alice:test'").fetchone())
        uses = self.service.store.db.execute('SELECT uses FROM invitations WHERE id=?', (invitation['id'],)).fetchone()[0]
        self.assertEqual(uses, 0 if stage == 'authority' else 1)
        self.assertFalse(any(path.endswith('/invite') for _, path, _, _ in self.upstream_calls))
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))

    async def test_invitation_authority_wait_cannot_recreate_redemption_after_deactivation(self):
        await self.invitation_race('authority')

    async def test_reserved_invitation_wait_cannot_recreate_state_or_invite_a_deleted_recipient(self):
        await self.invitation_race('token')

    async def registration_race(self, stage, reactivate=False):
        self.service.store.set('policy', {'registrationMode': 'open'})
        result = await self.request('POST', '/api/auth/register/start', {'username': 'newuser', 'password': 'Correct password!', 'confirmation': 'Correct password!', 'email': 'new@example.test'})
        self.assertEqual(result.status, 200, await result.text())
        challenge = (await result.json())['challengeId']
        code = re.search(r'\b\d{6}\b', self.service.send_email.call_args.args[2])[0]
        entered, release = asyncio.Event(), asyncio.Event()
        async def upstream(request, payload):
            native = self.tokens.get(request.headers.get('Authorization', '').removeprefix('Bearer '))
            match = request.path == '/_matrix/client/v3/account/whoami' if stage == 'whoami' else request.path == '/_synapse/admin/v1/users/@newuser:test/admin'
            if match and native and native[0] == '@newuser:test' and not entered.is_set():
                response = web.json_response({'user_id': native[0], 'device_id': native[1]} if stage == 'whoami' else {'admin': False})
                entered.set()
                await release.wait()
                return response
        self.upstream_response = upstream
        pending = asyncio.create_task(self.request('POST', '/api/auth/register/complete', {'challengeId': challenge, 'code': code}))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            cookie, _, _ = await self.login('newuser')
            result = await self.request('POST', '/api/account/deactivate', {'password': 'Correct password!', 'confirmation': '@newuser:test'}, cookie)
            self.assertEqual(result.status, 200, await result.text())
            if reactivate:
                result = await self.action(self.owner, 'enable', target='@newuser:test', newPassword='A new strong password!')
                self.assertEqual(result.status, 200, await result.text())
                self.assertFalse(self.users['@newuser:test']['deactivated'])
        finally:
            release.set()
        result = await asyncio.wait_for(pending, 2)
        self.assertEqual(result.status, 401, await result.text())
        self.assertNotIn('Set-Cookie', result.headers)
        self.assertFalse(self.service.store.db.execute("SELECT 1 FROM sessions WHERE user_id='@newuser:test'").fetchone())
        self.assertFalse(self.service.store.db.execute("SELECT 1 FROM social_preferences WHERE user_id='@newuser:test'").fetchone())
        if not reactivate:
            self.assertFalse(self.service.store.account('@newuser:test'))
        self.assertEqual(self.service.deactivations.view('@newuser:test')['phase'], 'reactivated' if reactivate else 'complete')

    async def test_registration_stale_whoami_cannot_recreate_deleted_account_or_cookie(self):
        await self.registration_race('whoami')

    async def test_registration_stale_admin_response_cannot_publish_a_deleted_session(self):
        await self.registration_race('admin')

    async def test_explicit_reactivation_cannot_revive_a_pre_deactivation_signin(self):
        await self.registration_race('whoami', reactivate=True)

    async def test_failed_native_permission_check_never_publishes_a_session_or_cookie(self):
        sessions = self.service.store.db.execute('SELECT count(*) FROM sessions').fetchone()[0]
        tokens = set(self.tokens)
        async def upstream(request, payload):
            if request.path == '/_synapse/admin/v1/users/@alice:test/admin':
                return web.Response(status=502)
        self.upstream_response = upstream
        result = await self.request('POST', '/api/auth/login', {'username': 'alice', 'password': 'Correct password!'})
        self.assertEqual(result.status, 502, await result.text())
        self.assertNotIn('Set-Cookie', result.headers)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM sessions').fetchone()[0], sessions)
        for _ in range(30):
            if set(self.tokens) <= tokens: break
            await asyncio.sleep(.01)
        self.assertLessEqual(set(self.tokens), tokens)


if __name__ == '__main__':
    unittest.main()
