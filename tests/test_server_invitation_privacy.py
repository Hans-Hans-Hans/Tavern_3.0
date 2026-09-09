import asyncio
import copy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from api.invitation_privacy import POLICY
from api.server import COOKIE
from api import invitation_privacy, server_invitation_privacy
from synapse_modules import invitation_policy
from tests import test_api as api_fixture
from tests import test_invitation_privacy as native_fixture

SERVER, SECOND = '!server:test', '!second:test'


class ServerInvitationNativeTests(unittest.IsolatedAsyncioTestCase):
    setUp = native_fixture.InvitationModuleTests.setUp

    def shared(self, identity=SERVER):
        for user in ('@alice:test', '@bob:test'):
            self.rooms.setdefault(user, []).append(identity)
        self.state[identity] = {('m.room.create', ''): SimpleNamespace(content={'type': 'm.space'}),
            **{('m.room.member', user): SimpleNamespace(content={'membership': 'join'}) for user in ('@alice:test', '@bob:test')}}

    async def test_each_current_shared_server_can_restrict_without_broadening_global_privacy(self):
        self.shared(); self.shared(SECOND)
        self.privacy.update(invitations='everyone', serverInvitations={SERVER: 'contacts', SECOND: 'nobody'})
        self.assertFalse(await self.policy.check(self.event))
        del self.privacy['serverInvitations'][SECOND]
        self.assertTrue(await self.policy.check(self.event))
        self.api.http_client.get_json.return_value = {'allowed': False}
        self.assertFalse(await self.policy.check(self.event))
        self.privacy.update(invitations='nobody', serverInvitations={})
        self.assertFalse(await self.policy.check(self.event))

    async def test_claimed_dm_parent_and_nonshared_or_channel_membership_do_not_select_a_policy(self):
        self.privacy['serverInvitations'] = {SERVER: 'nobody'}
        self.event.content.update(is_direct=True, serverId=SERVER)
        self.assertTrue(await self.policy.check(self.event))
        self.shared(); self.state[SERVER][('m.room.create', '')].content = {}
        self.assertTrue(await self.policy.check(self.event))
        self.state[SERVER][('m.room.create', '')].content = {'type': 'm.space'}
        self.assertFalse(await self.policy.check(self.event))
        self.state[SERVER][('m.room.member', '@bob:test')].content = {'membership': 'leave'}
        self.assertTrue(await self.policy.check(self.event))
        self.event.content['membership'] = 'join'
        self.assertTrue(await self.policy.check(self.event))

    async def test_rule_activation_and_new_shared_membership_during_contact_wait_are_rechecked(self):
        self.shared(); self.privacy.update(invitations='contacts', serverInvitations={SECOND: 'nobody'})
        async def consent(*args, **kwargs):
            self.shared(SECOND)
            return {'allowed': True}
        self.api.http_client.get_json.side_effect = consent
        self.assertFalse(await self.policy.check(self.event))
        self.privacy['serverInvitations'] = {}
        async def changed(*args, **kwargs):
            self.privacy['serverInvitations'] = {SERVER: 'nobody'}
            return {'allowed': True}
        self.api.http_client.get_json.side_effect = changed
        self.assertFalse(await self.policy.check(self.event))

    async def test_malformed_or_oversized_rules_and_unavailable_membership_fail_closed(self):
        for value in ([], None, {SERVER: 'everyone'}, {'!bad/path:test': 'nobody'}, {f'!s{i}:test': 'nobody' for i in range(201)}):
            self.privacy['serverInvitations'] = value
            self.assertFalse(await self.policy.check(self.event), value)
        self.privacy['serverInvitations'] = {SERVER: 'contacts'}
        async def broken(*args): raise OSError('unavailable')
        self.api._store.get_rooms_for_user = broken
        self.assertFalse(await self.policy.check(self.event))

    async def test_new_restricted_shared_space_during_final_privacy_read_is_denied(self):
        self.privacy.update(invitations='everyone', serverInvitations={SERVER: 'nobody'})
        original = self.api.account_data_manager.get_global
        reads = 0
        async def changed(user, kind):
            nonlocal reads
            if kind == POLICY:
                reads += 1
                if reads == 2: self.shared()
            return await original(user, kind)
        self.api.account_data_manager.get_global = changed
        self.assertFalse(await self.policy.check(self.event))
        self.assertEqual(reads, 2)

    async def test_shared_membership_loss_during_final_privacy_read_is_denied(self):
        self.shared(); self.privacy['invitations'] = 'shared_server'
        original = self.api.account_data_manager.get_global
        reads = 0
        async def changed(user, kind):
            nonlocal reads
            if kind == POLICY:
                reads += 1
                if reads == 2:
                    self.state[SERVER][('m.room.member', '@bob:test')].content = {'membership': 'leave'}
            return await original(user, kind)
        self.api.account_data_manager.get_global = changed
        self.assertFalse(await self.policy.check(self.event))

    async def test_contacts_removed_during_final_membership_read_are_rechecked(self):
        self.shared(); self.privacy['serverInvitations'] = {SERVER: 'contacts'}
        original, calls = self.api.get_room_state, 0
        async def changed(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2: self.api.http_client.get_json.return_value = {'allowed': False}
            return await original(*args, **kwargs)
        self.api.get_room_state = changed
        self.assertFalse(await self.policy.check(self.event))
        self.assertEqual(self.api.http_client.get_json.await_count, 2)

    async def test_native_deadline_cancels_stalled_state_and_later_checks_recover(self):
        self.shared(); self.privacy['invitations'] = 'shared_server'
        original, cancelled = self.api.get_room_state, asyncio.Event()
        async def stalled(*args, **kwargs):
            try: await asyncio.Event().wait()
            finally: cancelled.set()
        self.api.get_room_state = stalled
        with patch.object(invitation_policy, 'CHECK_TIMEOUT', 0.02):
            self.assertFalse(await asyncio.wait_for(self.policy.check(self.event), 1))
        self.assertTrue(cancelled.is_set())
        self.api.get_room_state = original
        self.assertTrue(await self.policy.check(self.event))

    async def test_native_deadline_includes_account_reads_and_contact_service(self):
        original = self.api.account_data_manager.get_global
        for operation in ('account', 'contact'):
            with self.subTest(operation=operation):
                self.privacy['invitations'] = 'contacts'
                cancelled = asyncio.Event()
                async def stalled(*args, **kwargs):
                    try: await asyncio.Event().wait()
                    finally: cancelled.set()
                self.api.account_data_manager.get_global = stalled if operation == 'account' else original
                self.api.http_client.get_json.side_effect = stalled if operation == 'contact' else None
                with patch.object(invitation_policy, 'CHECK_TIMEOUT', 0.02):
                    self.assertFalse(await asyncio.wait_for(self.policy.check(self.event), 1))
                self.assertTrue(cancelled.is_set())

    async def test_missing_native_deadline_contract_denies_only_new_local_invitations(self):
        del self.api.http_client.reactor
        self.assertFalse(await self.policy.check(self.event))
        self.event.content['membership'] = 'leave'
        self.assertTrue(await self.policy.check(self.event))
        self.event.content['membership'] = 'invite'; self.event.state_key = '@remote:elsewhere'
        self.assertTrue(await self.policy.check(self.event))

    async def test_explicit_falsey_invalid_account_documents_do_not_become_defaults(self):
        for kind in ('privacy', 'ignored'):
            for invalid in ([], False, 0, ''):
                with self.subTest(kind=kind, invalid=invalid):
                    self.privacy, self.ignored = {}, {}
                    setattr(self, kind, invalid)
                    self.assertFalse(await self.policy.check(self.event))
        for privacy in (None, {}):
            for ignored in (None, {}):
                with self.subTest(privacy=privacy, ignored=ignored):
                    self.privacy, self.ignored = privacy, ignored
                    self.assertTrue(await self.policy.check(self.event))
class ServerInvitationAPITests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = api_fixture.AccountAPITests.asyncTearDown
    request = api_fixture.AccountAPITests.request
    login = api_fixture.AccountAPITests.login
    endpoint = '/api/social/server-invitation-privacy'

    async def asyncSetUp(self):
        await api_fixture.AccountAPITests.asyncSetUp(self)
        self.saved = {'version': 1, 'invitations': 'contacts', 'anotherPreference': 'retained'}
        self.joined, self.creation = [SERVER], {'type': 'm.space'}
        self.writes = []
        original = self.service.matrix
        async def matrix(method, path, body=None, token=None, expected=True):
            if path.endswith('/account_data/' + POLICY):
                self.assertIsNotNone(token)
                self.assertIn('/user/%40alice%3Atest/', path)
                if method == 'PUT': self.saved = copy.deepcopy(body); self.writes.append(copy.deepcopy(body))
                return copy.deepcopy(self.saved) if expected else (200, copy.deepcopy(self.saved))
            if path.endswith('/joined_rooms'): return {'joined_rooms': self.joined}
            if path.endswith('/state/m.room.create'):
                if getattr(self, 'during_creation', None): await self.during_creation()
                return self.creation
            return await original(method, path, body, token=token, expected=expected)
        self.service.matrix = matrix
        self.cookie, _, _ = await self.login()

    async def read(self):
        response = await self.request('GET', self.endpoint, cookie=self.cookie)
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    async def save(self, servers, previous=None):
        previous = previous or await self.read()
        return await self.request('PUT', self.endpoint, {'servers': servers, 'revision': previous['revision']}, self.cookie)

    async def test_recipient_bound_saved_native_map_preserves_global_and_unknown_preferences(self):
        self.assertEqual((await self.request('GET', self.endpoint)).status, 401)
        previous = await self.read()
        self.assertEqual((await self.save({SERVER: 'nobody'}, previous)).status, 200)
        self.assertEqual(self.saved['invitations'], 'contacts'); self.assertEqual(self.saved['anotherPreference'], 'retained')
        self.assertEqual(self.saved['serverInvitations'], {SERVER: 'nobody'})
        self.assertEqual((await self.save({}, previous)).status, 409)
        changed = await self.request('PUT', '/api/social/invitation-privacy', {'invitations': 'nobody'}, self.cookie)
        self.assertEqual(changed.status, 200)
        self.assertEqual(self.saved['serverInvitations'], {SERVER: 'nobody'})

    async def test_new_rules_require_joined_space_but_departed_rules_can_be_removed(self):
        self.joined = []
        self.assertEqual((await self.save({SERVER: 'contacts'})).status, 403)
        self.joined = [SERVER]; self.creation = {}
        self.assertEqual((await self.save({SERVER: 'contacts'})).status, 400)
        self.saved['serverInvitations'] = {SERVER: 'nobody'}; self.joined = []
        self.assertEqual((await self.save({})).status, 200)
        self.assertEqual(self.saved['serverInvitations'], {})

    async def test_native_document_change_and_logout_during_membership_checks_prevent_write(self):
        async def changed(): self.saved['anotherPreference'] = 'other device changed it'
        self.during_creation = changed
        self.assertEqual((await self.save({SERVER: 'nobody'})).status, 409)
        self.assertEqual(self.writes, [])
        async def logout(): self.service.store.db.execute('DELETE FROM sessions')
        self.during_creation = logout
        self.assertEqual((await self.save({SERVER: 'nobody'})).status, 401)
        self.assertEqual(self.writes, [])

    async def test_invalid_rules_are_visible_and_can_be_explicitly_repaired(self):
        self.saved['serverInvitations'] = {SERVER: 'all'}
        previous = await self.read(); self.assertTrue(previous['invalid'])
        self.assertEqual((await self.save({SERVER: 'everyone'}, previous)).status, 400)
        self.assertEqual((await self.save({}, previous)).status, 200)
        self.assertFalse((await self.read())['invalid'])

    async def test_managed_global_and_server_edits_serialize_without_losing_either_choice(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def wait(): entered.set(); await release.wait()
        self.during_creation = wait
        first = asyncio.create_task(self.save({SERVER: 'contacts'}))
        await entered.wait()
        second = asyncio.create_task(self.request('PUT', '/api/social/invitation-privacy', {'invitations': 'nobody'}, self.cookie))
        release.set()
        results = await asyncio.gather(first, second)
        self.assertEqual([item.status for item in results], [200, 200])
        self.assertEqual(self.saved['invitations'], 'nobody')
        self.assertEqual(self.saved['serverInvitations'], {SERVER: 'contacts'})

    def stream_headers(self):
        device = self.service.store.db.execute('SELECT device_id FROM sessions WHERE cookie_hash=?', (self.service.store.digest(self.cookie),)).fetchone()[0]
        return {'Origin': self.config.public_url, 'Cookie': COOKIE + '=' + self.cookie,
                'Authorization': 'Bearer cookie-session:' + device, 'Content-Type': 'application/json'}

    async def test_streamed_global_put_cannot_overwrite_new_native_server_restriction(self):
        entered, release = asyncio.Event(), asyncio.Event()
        original = self.service.matrix
        async def observed(method, path, body=None, token=None, expected=True):
            result = await original(method, path, body, token, expected)
            if method == 'GET' and path.endswith('/account_data/' + POLICY): entered.set()
            return result
        self.service.matrix = observed
        async def body():
            yield b'{"invitations":"'
            await release.wait()
            yield b'everyone"}'
        pending = asyncio.create_task(self.client.put('/api/social/invitation-privacy', data=body(), headers=self.stream_headers()))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            self.saved['serverInvitations'] = {SERVER: 'nobody'}
        finally:
            release.set()
        response = await asyncio.wait_for(pending, 1)
        self.assertEqual(response.status, 409, await response.text())
        self.assertEqual(self.saved['serverInvitations'], {SERVER: 'nobody'})
        self.assertEqual(self.saved['invitations'], 'contacts')
        self.assertFalse(self.writes)

    async def test_settings_deadlines_include_waiting_for_another_request_lock(self):
        lock = self.service.user_locks.setdefault('@alice:test', asyncio.Lock())
        for module, endpoint in ((invitation_privacy, '/api/social/invitation-privacy'), (server_invitation_privacy, self.endpoint)):
            with self.subTest(endpoint=endpoint):
                await lock.acquire()
                try:
                    with patch.object(module, 'SETTINGS_TIMEOUT', 0.02):
                        response = await asyncio.wait_for(self.request('GET', endpoint, cookie=self.cookie), 1)
                    self.assertEqual(response.status, 504, await response.text())
                    self.assertTrue(lock.locked(), 'Timing out a waiter must not release another request owner')
                finally:
                    lock.release()
                self.assertEqual((await self.request('GET', endpoint, cookie=self.cookie)).status, 200)

    async def test_stalled_streamed_bodies_time_out_and_release_the_account_lock(self):
        original = self.service.matrix
        for module, endpoint in ((invitation_privacy, '/api/social/invitation-privacy'), (server_invitation_privacy, self.endpoint)):
            with self.subTest(endpoint=endpoint):
                entered, release = asyncio.Event(), asyncio.Event()
                async def observed(method, path, body=None, token=None, expected=True):
                    result = await original(method, path, body, token, expected)
                    if method == 'GET' and path.endswith('/account_data/' + POLICY): entered.set()
                    return result
                self.service.matrix = observed
                async def body():
                    yield b'{'
                    await release.wait()
                    yield b'}'
                with patch.object(module, 'SETTINGS_TIMEOUT', 0.02):
                    pending = asyncio.create_task(self.client.put(endpoint, data=body(), headers=self.stream_headers()))
                    try:
                        await asyncio.wait_for(entered.wait(), 1)
                        await asyncio.sleep(0.06)
                        self.assertFalse(self.service.user_locks['@alice:test'].locked())
                    finally:
                        release.set()
                    response = await asyncio.wait_for(pending, 1)
                self.assertEqual(response.status, 504, await response.text())
                self.assertFalse(self.writes)
                self.assertEqual((await self.request('GET', endpoint, cookie=self.cookie)).status, 200)

    async def test_global_settings_do_not_replace_malformed_native_document_with_defaults(self):
        self.saved = []
        response = await self.request('PUT', '/api/social/invitation-privacy', {'invitations': 'everyone'}, self.cookie)
        self.assertEqual(response.status, 502)
        self.assertFalse(self.writes)
