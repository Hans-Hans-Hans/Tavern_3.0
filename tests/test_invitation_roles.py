"""Invitation HTTP contracts against the deployed, canonical role policy.

The upstream fixture supplies real Matrix-shaped HTTP responses. Role writes
also pass through the actual Synapse module callback plus a native power check;
no alternate test implementation of role hierarchy is used.
"""
import asyncio
import copy
import time
import unittest
from types import SimpleNamespace

from api.server import APIError
from api.room_authority import policy_model
from tests import test_api_community as community_fixture
from tests import test_api as fixture


class InvitationRoleTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login
    add_user = community_fixture.CommunityAPITests.add_user
    create_invitation = community_fixture.CommunityAPITests.create_invitation

    async def asyncSetUp(self):
        await fixture.AccountAPITests.asyncSetUp(self)
        self.model = policy_model(self.service)
        self.policy = {
            'version': 1, 'owner': '@owner:test',
            'roles': [
                {'id': 'everyone', 'name': 'Member', 'position': 0, 'permissions': ['send_messages']},
                {'id': 'reader', 'name': 'Reader', 'position': 1, 'permissions': ['send_messages']},
                {'id': 'helper', 'name': 'Helper', 'position': 2, 'permissions': ['add_reactions']},
                {'id': 'manager', 'name': 'Manager', 'position': 20, 'permissions': ['manage_roles', 'invite', 'send_messages', 'add_reactions']},
                {'id': 'dangerous', 'name': 'Dangerous', 'position': 3, 'permissions': ['ban']},
            ],
            'members': {'@alice:test': ['manager']}, 'overrides': {}, 'categoryOverrides': {},
        }
        self.revision = 1
        self.role_writes = []
        self.role_attempts = []
        self.before_write = None
        self.before_role_login = None
        self.after_state = None
        self.joined = asyncio.Event()
        self.create_content = {'type': 'm.space', 'm.federate': False}
        self.module = self.model.TavernPolicy({}, SimpleNamespace(register_third_party_rules_callbacks=lambda **kwargs: None))
        self.native_role_reads = 0
        self.before_module_state = None
        original = self.service.matrix

        def policy_state(native):
            return [*copy.deepcopy(native),
                    {'type': 'm.room.create', 'state_key': '', 'sender': '@owner:test', 'content': copy.deepcopy(self.create_content)},
                    {'type': self.model.POLICY, 'state_key': '', 'sender': '@owner:test', 'event_id': '$roles-' + str(self.revision), 'content': copy.deepcopy(self.policy)}]

        async def get_room_state(identity):
            self.native_role_reads += 1
            if self.before_module_state:
                callback, self.before_module_state = self.before_module_state, None
                await callback()
            room = self.rooms[identity]
            native = [{'type': 'm.room.power_levels', 'state_key': '', 'content': room['powers']}]
            native += [{'type': 'm.room.member', 'state_key': user, 'content': {'membership': membership}} for user, membership in room['members'].items()]
            return {(event['type'], event['state_key']): SimpleNamespace(**event) for event in policy_state(native)}

        # The real public ModuleApi reads a new immutable state snapshot. Keep
        # that authority boundary when the deployed callback refreshes roles.
        self.module.api.get_room_state = get_room_state

        async def matrix(method, path, body=None, token=None, expected=True):
            if path.startswith('/_synapse/admin/v1/users/') and path.endswith('/login') and self.before_role_login and self.rooms['!room:test']['members'].get('@bob:test') == 'join':
                callback, self.before_role_login = self.before_role_login, None
                await callback()
            if method == 'PUT' and path.endswith('/state/' + self.model.POLICY + '/'):
                self.role_attempts.append((copy.deepcopy(body), token))
                if self.before_write:
                    callback, self.before_write = self.before_write, None
                    await callback()
                identity = self.tokens.get(token)
                if not identity:
                    raise APIError(401, 'Invalid native token.')
                actor = identity[0]
                room = self.rooms['!room:test']
                powers = room['powers']
                level = powers.get('users', {}).get(actor, powers.get('users_default', 0))
                required = powers.get('events', {}).get(self.model.POLICY, powers.get('state_default', 50))
                if room['members'].get(actor) != 'join' or level < required:
                    raise APIError(403, 'Native Matrix power level denied this event.')
                state = {('m.room.power_levels', ''): SimpleNamespace(content=powers)}
                state.update({(event['type'], event['state_key']): SimpleNamespace(**event) for event in policy_state([])})
                event = SimpleNamespace(room_id='!room:test', sender=actor, type=self.model.POLICY, state_key='', content=body)
                allowed, _ = await self.module.check_event_allowed(event, state)
                if not allowed:
                    raise APIError(403, 'The deployed policy rejected a stale or unauthorized event.')
                self.role_writes.append((copy.deepcopy(body), actor))
                self.policy = copy.deepcopy(body)
                self.revision += 1
                return {'event_id': '$roles-' + str(self.revision)}
            value = await original(method, path, body, token, expected)
            if path.startswith('/_matrix/client/v3/join/'):
                self.joined.set()
            if path.startswith('/_synapse/admin/v1/rooms/') and path.endswith('/state') and expected:
                value['state'] = policy_state(value['state'])
                if self.after_state:
                    callback, self.after_state = self.after_state, None
                    await callback()
            return value

        self.service.matrix = matrix
        # Production provisioning has an account service before ordinary users
        # can administer a server. The baseline fixture creates it on admin login.
        await self.login('owner')

    async def accept(self, invitation, cookie):
        return await self.request('POST', '/api/invitations/redeem', {'token': invitation['token']}, cookie)

    async def test_default_role_assignment_preserves_versioned_publication_policy(self):
        from synapse_modules.conference_publication import migration, MARKER, PUBLICATION
        self.policy = migration(self.policy)
        _, invitation = await self.create_invitation(defaultRoleIds=['reader'])
        bob = await self.add_user('bob')
        response = await self.accept(invitation, bob)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.policy[MARKER], 1)
        self.assertTrue(set(PUBLICATION) <= set(self.policy['roles'][0]['permissions']))
        self.assertEqual(self.policy['members']['@bob:test'], ['reader'])
        self.assertGreater(self.native_role_reads, 0)

    async def test_native_publication_migration_during_role_callback_rejects_stale_assignment(self):
        from synapse_modules.conference_publication import migration, MARKER
        _, invitation = await self.create_invitation(defaultRoleIds=['reader'])
        bob = await self.add_user('bob')
        async def migrate():
            self.policy = migration(self.policy)
            self.revision += 1
        self.before_module_state = migrate
        response = await self.accept(invitation, bob)
        self.assertEqual(response.status, 409, await response.text())
        self.assertEqual((await response.json())['errcode'], 'INVITATION_ROLES_PENDING')
        self.assertEqual(self.policy[MARKER], 1)
        self.assertNotIn('@bob:test', self.policy['members'])
        self.assertFalse(self.role_writes)
        resumed = await self.accept(invitation, bob)
        self.assertEqual(resumed.status, 200, await resumed.text())
        self.assertEqual(self.policy[MARKER], 1)
        self.assertEqual(self.policy['members']['@bob:test'], ['reader'])

    async def test_default_roles_assign_as_issuer_after_join_and_remain_idempotent(self):
        _, invitation = await self.create_invitation(defaultRoleIds=['reader', 'helper'])
        self.assertEqual(invitation['defaultRoleIds'], ['reader', 'helper'])
        bob = await self.add_user('bob')
        result = await self.accept(invitation, bob)
        self.assertEqual(result.status, 200, await result.text())
        self.assertEqual(self.policy['members']['@bob:test'], ['reader', 'helper'])
        self.assertEqual(self.role_writes[0][1], '@owner:test')
        self.assertTrue(self.role_attempts[0][1].startswith('impersonation-'))
        self.assertEqual(self.role_writes[0][0]['io.tavern.previous_event'], '$roles-1')
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))
        self.assertEqual((await self.accept(invitation, bob)).status, 200)
        self.assertEqual(len(self.role_writes), 1)
        self.assertEqual(self.service.store.db.execute('SELECT uses FROM invitations').fetchone()[0], 1)
        logins = [body for _, path, body, _ in self.upstream_calls if path.startswith('/_synapse/admin/v1/users/') and path.endswith('/login')]
        self.assertEqual(len(logins), 2)
        for body in logins:
            self.assertGreater(body['valid_until_ms'], time.time() * 1000)
            self.assertLess(body['valid_until_ms'], time.time() * 1000 + 61000)

    async def test_manager_cannot_create_higher_role_or_role_with_missing_permission(self):
        alice, _, _ = await self.login()
        for selected in (['manager'], ['dangerous'], ['missing']):
            with self.subTest(selected=selected):
                result = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'defaultRoleIds': selected}, alice)
                self.assertEqual(result.status, 403, await result.text())
        allowed = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'defaultRoleIds': ['reader', 'helper']}, alice)
        self.assertEqual(allowed.status, 201, await allowed.text())
        bob = await self.add_user('bob')
        self.assertEqual((await self.accept(await allowed.json(), bob)).status, 200)
        self.assertEqual(self.role_writes[0][1], '@alice:test')

    async def test_default_role_input_and_native_power_ceiling_are_enforced(self):
        owner, _, _ = await self.login('owner')
        for selected in (['everyone'], ['reader', 'reader'], [1], 'reader', ['r' + str(index) for index in range(21)]):
            with self.subTest(selected=selected):
                result = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'defaultRoleIds': selected}, owner)
                self.assertEqual(result.status, 400, await result.text())
        self.rooms['!room:test']['powers']['events'] = {self.model.POLICY: 101}
        result = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'defaultRoleIds': ['reader']}, owner)
        self.assertEqual(result.status, 403)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitations').fetchone()[0], 0)

    async def test_roles_must_belong_to_an_enabled_local_server_policy(self):
        owner, _, _ = await self.login('owner')
        self.create_content = {}
        result = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'defaultRoleIds': ['reader']}, owner)
        self.assertEqual(result.status, 400)
        self.create_content = {'type': 'm.space', 'm.federate': False}
        self.create_content['m.federate'] = True
        result = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'defaultRoleIds': ['reader']}, owner)
        self.assertEqual(result.status, 400)
        self.create_content['m.federate'] = False
        self.policy['version'] = 9
        result = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'defaultRoleIds': ['reader']}, owner)
        self.assertEqual(result.status, 400)

    async def test_revoked_role_authority_is_checked_before_reserving_capacity(self):
        alice, _, _ = await self.login()
        created = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'defaultRoleIds': ['reader']}, alice)
        self.assertEqual(created.status, 201)
        invitation = await created.json()
        bob = await self.add_user('bob')
        self.policy['roles'][1]['permissions'] = ['ban']
        result = await self.accept(invitation, bob)
        self.assertEqual(result.status, 403)
        self.assertEqual(self.service.store.db.execute('SELECT uses FROM invitations').fetchone()[0], 0)
        self.assertFalse(self.role_attempts)

    async def test_redeemer_cannot_use_default_roles_to_elevate_the_issuer_or_peer(self):
        alice, _, _ = await self.login()
        created = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'defaultRoleIds': ['reader'], 'maxUses': 3}, alice)
        self.assertEqual(created.status, 201)
        invitation = await created.json()
        result = await self.accept(invitation, alice)
        self.assertEqual(result.status, 409)
        self.assertEqual((await result.json())['errcode'], 'INVITATION_ROLES_PENDING')
        bob = await self.add_user('bob')
        self.policy['members']['@bob:test'] = ['manager']
        self.assertEqual((await self.accept(invitation, bob)).status, 409)
        self.policy['members']['@bob:test'] = []
        self.rooms['!room:test']['powers']['users']['@bob:test'] = 50
        self.assertEqual((await self.accept(invitation, bob)).status, 409)
        self.assertFalse(self.role_attempts)

    async def test_fresh_merge_preserves_unrelated_concurrent_member_changes(self):
        _, invitation = await self.create_invitation(defaultRoleIds=['reader'])
        bob = await self.add_user('bob')
        async def concurrent_change():
            self.policy['members']['@charlie:test'] = ['helper']
            self.policy['members']['@bob:test'] = ['helper']
            self.revision += 1
        self.before_role_login = concurrent_change
        result = await self.accept(invitation, bob)
        self.assertEqual(result.status, 200, await result.text())
        self.assertEqual(self.policy['members']['@charlie:test'], ['helper'])
        self.assertEqual(self.policy['members']['@bob:test'], ['helper', 'reader'])
        self.assertEqual(self.role_writes[0][0]['io.tavern.previous_event'], '$roles-2')

    async def test_recipient_session_revoked_during_role_token_request_prevents_grant(self):
        _, invitation = await self.create_invitation(defaultRoleIds=['reader'])
        bob = await self.add_user('bob')
        async def revoke_recipient():
            self.service.store.db.execute("DELETE FROM sessions WHERE user_id='@bob:test'")
        self.before_role_login = revoke_recipient
        result = await self.accept(invitation, bob)
        self.assertEqual(result.status, 401, await result.text())
        self.assertFalse(self.role_attempts)
        self.assertNotIn('@bob:test', self.policy['members'])
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))

    async def test_deployed_revision_guard_rejects_race_and_recipient_resumes_at_capacity(self):
        _, invitation = await self.create_invitation(defaultRoleIds=['reader'])
        bob = await self.add_user('bob')
        async def concurrent_change():
            self.policy['members']['@charlie:test'] = ['helper']
            self.revision += 1
        self.before_write = concurrent_change
        result = await self.accept(invitation, bob)
        self.assertEqual(result.status, 409, await result.text())
        self.assertEqual((await result.json())['errcode'], 'INVITATION_ROLES_PENDING')
        self.assertEqual(self.rooms['!room:test']['members']['@bob:test'], 'join')
        self.assertNotIn('@bob:test', self.policy['members'])
        self.assertEqual(self.service.store.db.execute('SELECT state FROM invitation_redemptions').fetchone()[0], 'invited')
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))
        preview = '/api/invitations/preview/' + invitation['token']
        self.assertEqual((await self.request('GET', preview)).status, 404)
        charlie = await self.add_user('charlie')
        self.assertEqual((await self.request('GET', preview, cookie=charlie)).status, 404)
        self.assertEqual((await self.request('GET', preview, cookie=bob)).status, 200)
        result = await self.accept(invitation, bob)
        self.assertEqual(result.status, 200, await result.text())
        self.assertEqual(self.policy['members']['@charlie:test'], ['helper'])
        self.assertEqual(self.policy['members']['@bob:test'], ['reader'])
        self.assertEqual(self.service.store.db.execute('SELECT uses FROM invitations').fetchone()[0], 1)
        self.assertEqual(self.service.store.db.execute('SELECT state FROM invitation_redemptions').fetchone()[0], 'joined')

    async def test_suspension_during_remote_state_read_prevents_a_new_invitation(self):
        owner, _, _ = await self.login('owner')
        async def suspend():
            self.service.store.db.execute("UPDATE accounts SET access_blocked='suspend' WHERE user_id='@owner:test'")
        self.after_state = suspend
        result = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'defaultRoleIds': ['reader']}, owner)
        self.assertEqual(result.status, 403)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitations').fetchone()[0], 0)

    async def test_suspended_issuer_cannot_redeem_and_uncertain_native_failure_stays_reserved(self):
        _, invitation = await self.create_invitation(defaultRoleIds=['reader'])
        bob = await self.add_user('bob')
        self.service.store.db.execute("UPDATE accounts SET access_blocked='suspend' WHERE user_id='@owner:test'")
        self.assertEqual((await self.accept(invitation, bob)).status, 403)
        self.assertEqual(self.service.store.db.execute('SELECT uses FROM invitations').fetchone()[0], 0)
        self.service.store.db.execute("UPDATE accounts SET access_blocked='' WHERE user_id='@owner:test'")
        async def change_native_power():
            self.rooms['!room:test']['powers']['events'] = {self.model.POLICY: 101}
        self.before_write = change_native_power
        result = await self.accept(invitation, bob)
        self.assertEqual(result.status, 409)
        self.assertFalse(self.role_writes)
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))
        self.assertEqual(self.service.store.db.execute('SELECT uses FROM invitations').fetchone()[0], 1)

    async def test_in_progress_suspension_finishes_before_a_waiting_role_assignment(self):
        _, invitation = await self.create_invitation(defaultRoleIds=['reader'])
        bob = await self.add_user('bob')
        lock = self.service.user_locks.setdefault('@owner:test', asyncio.Lock())
        async with lock:
            redemption = asyncio.create_task(self.accept(invitation, bob))
            await asyncio.wait_for(self.joined.wait(), 3)
            self.service.store.db.execute("UPDATE accounts SET access_blocked='suspend' WHERE user_id='@owner:test'")
        result = await asyncio.wait_for(redemption, 3)
        self.assertEqual(result.status, 409, await result.text())
        self.assertEqual((await result.json())['errcode'], 'INVITATION_ROLES_PENDING')
        self.assertFalse(self.role_attempts)
        self.assertFalse(any(token.startswith('impersonation-') for token in self.tokens))


if __name__ == '__main__':
    unittest.main()
