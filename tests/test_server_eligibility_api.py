import hashlib
import hmac
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from aiohttp import web
from api.server import APIError
from api.server_eligibility import register_routes, require_room_eligibility
from synapse_modules.server_account_eligibility import ELIGIBILITY, signature
from tests import test_api as fixture
from tests.test_server_eligibility import config


class EligibilityAPITests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def asyncSetUp(self):
        original = fixture.create_app
        def mounted(config):
            app = original(config)
            if not any(route.resource.canonical == '/api/internal/server-eligibility' for route in app.router.routes()):
                register_routes(app)
            return app
        with patch.object(fixture, 'create_app', mounted):
            await fixture.AccountAPITests.asyncSetUp(self)
        self.key = bytes(range(32))
        path = Path(self.directory.name) / 'privacy.key'; path.write_text(self.key.hex())
        self.environment = patch.dict(os.environ, {'PRIVACY_KEY_FILE': str(path)}); self.environment.start()
        self.addCleanup(self.environment.stop)

    async def internal(self, user='@alice:test', timestamp=None, supplied=None, extra=''):
        timestamp = str(int(time.time())) if timestamp is None else timestamp
        headers = {'X-Tavern-Privacy-Timestamp': timestamp,
                   'X-Tavern-Privacy-Signature': signature(self.key, timestamp, user) if supplied is None else supplied}
        return await self.client.get('/api/internal/server-eligibility?' + urlencode({'user': user}) + extra, headers=headers)

    async def test_actual_http_requires_domain_scoped_fresh_signature(self):
        denied = await self.client.get('/api/internal/server-eligibility?user=%40alice%3Atest')
        self.assertEqual(denied.status, 403)
        timestamp = str(int(time.time()))
        other = hmac.new(self.key, '\n'.join(('v1', 'invitation-consent', timestamp, '@alice:test', '@bob:test')).encode(), hashlib.sha256).hexdigest()
        for kwargs in ({'supplied': other, 'timestamp': timestamp}, {'timestamp': str(int(time.time()) - 31)}, {'supplied': 'bad'}, {'supplied': 'é' * 64}, {'supplied': 'A' * 64}, {'extra': '&emailVerified=true'}, {'extra': '&user=%40owner%3Atest'}, {'user': '@alice:test\n@owner:test'}):
            response = await self.internal(**kwargs)
            self.assertEqual(response.status, 403, kwargs)

    async def test_endpoint_reads_current_record_never_discloses_email_or_creates_account(self):
        response = await self.internal()
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {'available': True, 'emailVerified': False})
        self.assertEqual(self.service.store.account('@alice:test'), {})
        await self.login()
        self.service.store.db.execute('UPDATE accounts SET email=?,verified=1 WHERE user_id=?', ('private@example.com', '@alice:test'))
        response = await self.internal()
        self.assertEqual(await response.json(), {'available': True, 'emailVerified': True})
        self.assertEqual(response.headers.get('Cache-Control'), 'no-store')
        self.service.store.db.execute('UPDATE accounts SET verified=0 WHERE user_id=?', ('@alice:test',))
        self.assertEqual((await (await self.internal()).json())['emailVerified'], False)
        self.assertNotIn('private@example.com', await response.text())

    async def test_restriction_and_durable_deactivation_journal_close_bridge_immediately(self):
        await self.login()
        self.service.store.db.execute('UPDATE accounts SET access_blocked=? WHERE user_id=?', ('restricted', '@alice:test'))
        self.assertFalse((await (await self.internal()).json())['available'])
        self.service.store.db.execute('UPDATE accounts SET access_blocked=? WHERE user_id=?', ('', '@alice:test'))
        identity = self.service.deactivations.begin('@alice:test', False)
        self.assertFalse((await (await self.internal()).json())['available'])
        self.service.store.db.execute("UPDATE account_deactivations SET phase='complete' WHERE id=?", (identity,))
        self.service.store.db.execute('DELETE FROM accounts WHERE user_id=?', ('@alice:test',))
        self.assertFalse((await (await self.internal()).json())['available'])

    async def setup_authority(self):
        await self.login('owner')
        await self.login()
        self.actor, self.room, self.parent = '@alice:test', '!voice:test', '!server:test'
        self.session = dict(self.service.store.db.execute('SELECT * FROM sessions WHERE user_id=?', (self.actor,)).fetchone())
        def item(kind, body, key='', sender='@owner:test'):
            return {'type': kind, 'state_key': key, 'sender': sender, 'event_id': '$' + kind, 'content': body}
        self.events = [item('m.room.create', {'type': 'm.space', 'm.federate': False}),
                       item('m.space.child', {'via': ['test']}, self.room), item(ELIGIBILITY, config())]
        self.current = {('m.room.create', ''): SimpleNamespace(content={'m.federate': False}, sender='@owner:test'),
                        ('m.space.parent', self.parent): SimpleNamespace(content={'via': ['test'], 'canonical': True})}
        self.users[self.actor].update(creation_ts=int(time.time()) - 90000, is_guest=False, locked=False, suspended=False)
        async def native(request, payload):
            if request.path == '/_synapse/admin/v1/rooms/' + self.parent + '/state':
                return web.json_response({'state': self.events})
            if request.path == '/_synapse/admin/v1/rooms/' + self.room + '/state':
                return web.json_response({'state': [{'type': kind, 'state_key': key, 'sender': getattr(event, 'sender', None), 'content': event.content} for (kind, key), event in self.current.items()]})
            return None
        self.upstream_response = native

    async def test_real_native_admin_detail_age_and_current_email_are_shared_with_rtc(self):
        await self.setup_authority()
        with self.assertRaises(APIError) as denied:
            await require_room_eligibility(self.service, self.session, self.room, self.current)
        self.assertEqual(denied.exception.code, 'SERVER_ELIGIBILITY_REQUIRED')
        self.service.store.db.execute('UPDATE accounts SET email=?,verified=1 WHERE user_id=?', ('alice@example.com', self.actor))
        await require_room_eligibility(self.service, self.session, self.room, self.current)
        self.events[-1]['content'] = config(requireVerifiedEmail=False, minimumAccountAgeSeconds=3600)
        # Companion creation is deliberately old. Native creation still wins.
        self.service.store.db.execute('UPDATE accounts SET created=1 WHERE user_id=?', (self.actor,))
        self.users[self.actor]['creation_ts'] = int(time.time()) - 10
        with self.assertRaises(APIError): await require_room_eligibility(self.service, self.session, self.room, self.current)
        self.users[self.actor]['creation_ts'] = int(time.time()) - 3600
        await require_room_eligibility(self.service, self.session, self.room, self.current)
        self.assertTrue(any(path == '/_synapse/admin/v2/users/' + self.actor for _, path, _, _ in self.upstream_calls))

    async def test_native_malformed_user_identity_and_future_millisecond_age_fail_closed(self):
        await self.setup_authority()
        self.events[-1]['content'] = config(requireVerifiedEmail=False, minimumAccountAgeSeconds=300)
        native = self.upstream_response
        for bad in ({'name': '@wrong:test', 'deactivated': False, 'creation_ts': 1}, {'name': self.actor, 'creation_ts': 1}, {'name': self.actor, 'deactivated': False, 'creation_ts': int(time.time()) * 1000}):
            async def changed(request, payload):
                if request.path == '/_synapse/admin/v2/users/' + self.actor:
                    return web.json_response(bad)
                return await native(request, payload)
            self.upstream_response = changed
            with self.assertRaises(APIError): await require_room_eligibility(self.service, self.session, self.room, self.current)

    async def test_rtc_native_availability_is_required_with_optional_policy_off_or_absent(self):
        await self.setup_authority()
        self.events[-1]['content'] = config(requireVerifiedEmail=False)
        for has_policy in (True, False):
            if not has_policy:
                self.events.pop()
            await require_room_eligibility(self.service, self.session, self.room, self.current)
            for field in ('deactivated', 'is_guest', 'locked', 'suspended'):
                for bad in (True, 0, None, 'false'):
                    self.users[self.actor][field] = bad
                    with self.assertRaises(APIError, msg=(has_policy, field, bad)):
                        await require_room_eligibility(self.service, self.session, self.room, self.current)
                self.users[self.actor][field] = False

    async def test_native_suspension_during_final_room_lookup_does_not_admit_call(self):
        await self.setup_authority()
        self.service.store.db.execute('UPDATE accounts SET email=?,verified=1 WHERE user_id=?', ('alice@example.com', self.actor))
        native, count = self.upstream_response, 0
        async def changed(request, payload):
            nonlocal count
            if request.path.endswith('/state'):
                count += 1
                if count == 2:
                    self.users[self.actor]['suspended'] = True
            return await native(request, payload)
        self.upstream_response = changed
        with self.assertRaises(APIError):
            await require_room_eligibility(self.service, self.session, self.room, self.current)

    async def test_revocation_during_final_parent_lookup_does_not_admit_call(self):
        await self.setup_authority()
        self.events[-1]['content'] = config(requireVerifiedEmail=False, minimumAccountAgeSeconds=300)
        native, count = self.upstream_response, 0
        async def changed(request, payload):
            nonlocal count
            if request.path.endswith('/state'):
                count += 1
                if count == 2:
                    self.service.store.db.execute('UPDATE accounts SET access_blocked=? WHERE user_id=?', ('restricted', self.actor))
            return await native(request, payload)
        self.upstream_response = changed
        with self.assertRaises(APIError): await require_room_eligibility(self.service, self.session, self.room, self.current)

    async def test_email_verification_removed_during_final_native_lookup_is_not_stale_allow(self):
        await self.setup_authority()
        self.service.store.db.execute('UPDATE accounts SET email=?,verified=1 WHERE user_id=?', ('alice@example.com', self.actor))
        native, count = self.upstream_response, 0
        async def changed(request, payload):
            nonlocal count
            if request.path.endswith('/state'):
                count += 1
                if count == 2:
                    self.service.store.db.execute('UPDATE accounts SET verified=0 WHERE user_id=?', (self.actor,))
            return await native(request, payload)
        self.upstream_response = changed
        with self.assertRaises(APIError): await require_room_eligibility(self.service, self.session, self.room, self.current)
