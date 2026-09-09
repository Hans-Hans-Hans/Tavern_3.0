import copy
import time
from types import SimpleNamespace
from unittest.mock import patch
import unittest

from api.server import APIError
from synapse_modules.temporary_ban import TEMPBAN, TemporaryBanPolicy, active
from synapse_modules.tavern_policy import TavernPolicy, permissions, rank, POLICY
from tests import test_moderation as fixture


def event(kind, sender='@member:test', content=None, key=None, identity='$event'):
    return SimpleNamespace(type=kind, sender=sender, content=content or {}, state_key=key, room_id='!room:test', event_id=identity)


class TemporaryBanPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original = None
        self.parent = {}
        self.filters = []
        async def lookup(target, allow_none=False): return self.original
        async def state(identity, filters=None):
            self.filters = filters
            return {key: value for key, value in self.parent.items() if filters is None or key in filters}
        async def account_data(user, kind): return {}
        self.api = SimpleNamespace(_store=SimpleNamespace(get_event=lookup), get_room_state=state,
            register_third_party_rules_callbacks=lambda **kwargs: None, is_mine=lambda user: True,
            account_data_manager=SimpleNamespace(get_global=account_data))
        self.module = TemporaryBanPolicy(self.api, permissions, rank)
        self.state = {('m.room.power_levels', ''): event('m.room.power_levels', content={'users': {'@owner:test': 100, '@mod:test': 50, '@peer:test': 50}, 'users_default': 0}),
            ('m.room.member', '@mod:test'): event('m.room.member', content={'membership': 'join'})}
        self.role = {'version': 1, 'owner': '@owner:test', 'roles': [{'id': 'everyone', 'name': 'Member', 'position': 0, 'permissions': ['send_messages']},
            {'id': 'moderator', 'name': 'Moderator', 'position': 50, 'permissions': ['ban', 'kick']}], 'members': {'@mod:test': ['moderator']}}

    async def test_deadline_uses_server_time_for_writes_admission_and_calls(self):
        self.state[(TEMPBAN, '@member:test')] = event(TEMPBAN, content={'version': 1, 'until': 1000001})
        with patch('synapse_modules.temporary_ban.time.time', return_value=1000):
            for kind in ['m.room.message', 'm.room.encrypted', 'm.reaction', 'm.room.power_levels', POLICY, 'm.call.invite', 'm.call.answer', 'org.matrix.msc3401.call.member']:
                self.assertFalse(await self.module.check(event(kind, content={'active': True}), self.state, []), kind)
            for membership in ['join', 'invite', 'knock']:
                self.assertFalse(await self.module.check(event('m.room.member', sender='@owner:test', key='@member:test', content={'membership': membership}), self.state, []))
            self.assertTrue(await self.module.check(event('m.room.member', key='@member:test', content={'membership': 'leave'}), self.state, []))
        with patch('synapse_modules.temporary_ban.time.time', return_value=1001):
            self.assertTrue(await self.module.check(event('m.room.encrypted'), self.state, []))
            self.assertTrue(await self.module.check(event('m.room.member', key='@member:test', content={'membership': 'join'}), self.state, []))

    async def test_cleanup_only_allows_own_existing_call_state(self):
        self.state[(TEMPBAN, '@member:test')] = event(TEMPBAN, content={'version': 1, 'until': int(time.time() * 1000) + 100000})
        self.state[('org.matrix.msc3401.call.member', 'device')] = event('org.matrix.msc3401.call.member')
        self.state[('org.matrix.msc3401.call.member', 'other')] = event('org.matrix.msc3401.call.member', sender='@owner:test')
        for content in [{}, {'memberships': []}]:
            self.assertTrue(await self.module.check(event('org.matrix.msc3401.call.member', key='device', content=content), self.state, []))
            self.assertFalse(await self.module.check(event('org.matrix.msc3401.call.member', key='other', content=content), self.state, []))
        self.assertTrue(await self.module.check(event('m.call.hangup'), self.state, []))

    async def test_native_role_hierarchy_revision_and_duration_cannot_be_bypassed(self):
        action = event(TEMPBAN, sender='@mod:test', key='@member:test', content={'version': 1, 'until': int(time.time() * 1000) + 100000, 'io.tavern.previous_event': None})
        policies = [('!room:test', self.role, self.state)]
        self.assertTrue(await self.module.check(action, self.state, policies))
        for target in ['@mod:test', '@peer:test', '@owner:test']:
            other = copy.deepcopy(action); other.state_key = target
            self.assertFalse(await self.module.check(other, self.state, policies))
        self.role['roles'][1]['permissions'] = ['kick']
        self.assertFalse(await self.module.check(action, self.state, policies))
        self.role['roles'][1]['permissions'].append('ban')
        for until in [True, -1, int(time.time() * 1000) - 1, int(time.time() * 1000) + 29 * 86400000]:
            other = copy.deepcopy(action); other.content['until'] = until
            self.assertFalse(await self.module.check(other, self.state, policies))
        self.state[(TEMPBAN, '@member:test')] = event(TEMPBAN, content={'version': 1, 'until': 0}, identity='$new')
        self.assertFalse(await self.module.check(action, self.state, policies))
        action.content['io.tavern.previous_event'] = '$new'
        self.assertTrue(await self.module.check(action, self.state, policies))
        self.state[('m.room.member', '@mod:test')].content['membership'] = 'leave'
        self.assertFalse(await self.module.check(action, self.state, policies))

    async def test_reciprocal_canonical_parent_blocks_other_client_admission_and_role_edits(self):
        self.parent = {(POLICY, ''): event(POLICY, content=self.role), ('m.space.child', '!room:test'): event('m.space.child', content={'via': ['test']}),
            (TEMPBAN, '@member:test'): event(TEMPBAN, content={'version': 1, 'until': int(time.time() * 1000) + 100000})}
        self.state[('m.space.parent', '!parent:test')] = event('m.space.parent', content={'canonical': True, 'via': ['test']})
        module = TavernPolicy({}, self.api)
        self.assertEqual(await module.check_event_allowed(event('m.room.encrypted'), self.state), (False, None))
        self.assertEqual(await module.check_event_allowed(event('m.room.member', sender='@mod:test', key='@member:test', content={'membership': 'invite'}), self.state), (False, None))
        self.assertIn((TEMPBAN, '@member:test'), self.filters)
        self.assertEqual(await module.check_event_allowed(event('m.room.member', key='@member:test', content={'membership': 'leave'}), self.state), (True, None))
        self.parent.pop(('m.space.child', '!room:test'))
        self.assertEqual(await module.check_event_allowed(event('m.room.encrypted'), self.state), (True, None))

    async def test_redaction_or_malformed_state_does_not_remove_restriction(self):
        self.original = event(TEMPBAN)
        self.assertFalse(await self.module.check(event('m.room.redaction', sender='@owner:test', content={'redacts': '$ban'}), self.state, []))
        for data in [{}, {'version': 1, 'until': 'expired'}, {'version': 1, 'until': -1}, {'version': 2, 'until': 0}]:
            self.state[(TEMPBAN, '@member:test')] = event(TEMPBAN, content=data)
            self.assertTrue(active(self.state, '@member:test', int(time.time() * 1000)))


class TemporaryBanAPITests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.WarningTests.asyncTearDown
    request = fixture.WarningTests.request
    login = fixture.WarningTests.login
    managed = fixture.WarningTests.managed

    async def asyncSetUp(self):
        await fixture.WarningTests.asyncSetUp(self)
        self.kick_fails = False
        self.mutations = []
        original = self.service.matrix
        async def matrix(method, path, body=None, token=None, expected=True):
            from urllib.parse import unquote
            decoded = unquote(path)
            if '/state/' + TEMPBAN + '/' in decoded and method == 'PUT':
                identity, target = decoded.removeprefix('/_matrix/client/v3/rooms/').split('/state/' + TEMPBAN + '/')
                self.mutations.append((method, decoded, body, token))
                self.extra[identity] = [row for row in self.extra.get(identity, []) if (row['type'], row['state_key']) != (TEMPBAN, target)] + [{'type': TEMPBAN, 'state_key': target, 'content': copy.deepcopy(body), 'sender': '@owner:test', 'event_id': '$ban' + str(len(self.mutations))}]
                return {'event_id': '$ban' + str(len(self.mutations))}
            if decoded.endswith('/kick'):
                self.mutations.append((method, decoded, body, token))
                if self.kick_fails: raise APIError(403, 'Kick permission changed')
                identity = decoded.removeprefix('/_matrix/client/v3/rooms/').removesuffix('/kick')
                self.rooms[identity]['members'][body['user_id']] = 'leave'
                return {}
            return await original(method, path, body, token, expected)
        self.service.matrix = matrix

    async def change(self, cookie, **changes):
        return await self.request('POST', '/api/moderation/temporary-bans', {'action': 'apply', 'roomId': '!room:test', 'targetId': '@alice:test', 'confirmation': '@alice:test', 'reason': 'Public moderation reason', 'durationSeconds': 3600, 'previousEventId': None, **changes}, cookie)

    async def test_applies_before_native_kick_using_only_operator_token_then_lifts_without_rejoin(self):
        cookie, _, _ = await self.login('owner')
        result = await self.change(cookie); self.assertEqual(result.status, 200, await result.text())
        value = await result.json(); self.assertTrue(value['restrictionApplied']); self.assertTrue(value['membershipRemoved'])
        self.assertEqual([row[0] for row in self.mutations], ['PUT', 'POST'])
        self.assertTrue(all(self.tokens[row[3]][0] == '@owner:test' for row in self.mutations))
        self.assertNotIn('Public moderation reason', str(list(self.service.store.db.execute('SELECT detail FROM audit'))))
        current = await (await self.request('GET', '/api/moderation/temporary-bans?roomId=!room:test&targetId=@alice:test', cookie=cookie)).json()
        self.assertTrue(current['restriction']['active'])
        result = await self.change(cookie, action='lift', previousEventId=value['eventId']); self.assertEqual(result.status, 200)
        self.assertEqual((await result.json())['until'], 0); self.assertEqual(self.rooms['!room:test']['members']['@alice:test'], 'leave')
        self.assertEqual(len(self.mutations), 3)

    async def test_kick_failure_is_explicit_and_does_not_roll_back_live_restriction(self):
        cookie, _, _ = await self.login('owner'); self.kick_fails = True
        response = await self.change(cookie); self.assertEqual(response.status, 200, await response.text())
        value = await response.json(); self.assertTrue(value['restrictionApplied']); self.assertFalse(value['membershipRemoved'])
        self.assertIn('may still read', value['message']); self.assertTrue(self.extra['!room:test'][0]['content']['until'] > time.time() * 1000)

    async def test_checks_all_parents_role_hierarchy_native_power_and_current_revision(self):
        cookie, _, _ = await self.login('owner'); policy = self.managed(); other = self.managed('!other:test')
        policy['roles'][1]['permissions'] = ['ban']; other['roles'][1]['permissions'] = []
        self.assertEqual((await self.change(cookie)).status, 403)
        other['roles'][1]['permissions'] = ['ban']; other['members']['@alice:test'] = ['moderator']
        self.assertEqual((await self.change(cookie)).status, 403)
        other['members'].pop('@alice:test')
        self.assertEqual((await self.change(cookie, previousEventId='$stale')).status, 409)
        self.rooms['!room:test']['powers']['users']['@owner:test'] = 50
        self.assertEqual((await self.change(cookie)).status, 403)
        self.assertFalse(self.mutations)

    async def test_invalid_duration_permanent_ban_and_confirmation_do_not_mutate(self):
        cookie, _, _ = await self.login('owner')
        for seconds in [True, 0, 59, 28 * 86400 + 1, '3600']:
            self.assertEqual((await self.change(cookie, durationSeconds=seconds)).status, 400)
        self.assertEqual((await self.change(cookie, confirmation='alice')).status, 400)
        self.rooms['!room:test']['members']['@alice:test'] = 'ban'
        self.assertEqual((await self.change(cookie)).status, 409)
        self.assertFalse(self.mutations)


if __name__ == '__main__': unittest.main()
