"""Migration semantics; actual Synapse auth is exercised by the native smoke."""
import copy
import time
import unittest
from synapse_modules.member_state import member_state_key as key, member_state_target as target, member_state_event as read
from synapse_modules.channel_policy import TIMEOUT, timeout_active
from synapse_modules.temporary_ban import TEMPBAN, active
from synapse_modules.server_nickname import NICKNAME
from tests import test_roles as fixture
event = fixture.event


class MemberStateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixture.EventTests.asyncSetUp(self)
        self.policy['roles'][1]['permissions'] += ['timeout', 'manage_nicknames', 'ban']
        self.server[('m.room.create', '')] = event('m.room.create', sender='@owner:local', body={'type': 'm.space', 'm.federate': False, 'room_version': '12'})
        self.server[('m.room.power_levels', '')] = event('m.room.power_levels', body={'users': {'@mod:local': 50}, 'state_default': 50})
        for user in ('@owner:local', '@mod:local', '@member:local'):
            self.server[('m.room.member', user)] = event('m.room.member', key=user, body={'membership': 'join'})

    def test_canonical_keys_preserve_255_byte_identity_and_reject_alternate_or_reserved_keys(self):
        for user in ('@member:local', '@_member:local', '@' + 'a' * 249 + ':test', '@' + 'é' * 124 + 'a:test', '@😀:test'):
            self.assertEqual(target(key(user)), user)
            self.assertEqual(len(key(user).encode()), len(user.encode()))
        for user in ('@' + 'a' * 250 + ':test', '@' + 'é' * 125 + ':test', '@bad\ud800:test', '@bad\n:test', '@bad/path:test', '@:test', '@a:', '_a:test'):
            with self.assertRaises(ValueError): key(user)
        for value in ('@a:test', 'user:@a:test', '_', '__:'):
            with self.assertRaises(ValueError): target(value)

    async def write(self, kind, body, state_key='_member:local'):
        return await self.module.check_event_allowed(event(kind, sender='@mod:local', key=state_key, room='!server:local', body=body), self.server)

    async def test_all_new_writes_use_canonical_key_and_legacy_revision_before_migration(self):
        for kind, data, cleared in ((TIMEOUT, {'until': int(time.time() * 1000) + 100000}, {'until': 0}),
                                   (TEMPBAN, {'version': 1, 'until': int(time.time() * 1000) + 100000}, {'version': 1, 'until': 0}),
                                   (NICKNAME, {'version': 1, 'name': 'Nickname'}, {'version': 1, 'name': None})):
            with self.subTest(kind=kind):
                self.server[(kind, '@member:local')] = event(kind, key='@member:local', body=data, eid='$legacy')
                self.assertEqual(await self.write(kind, {**cleared, 'io.tavern.previous_event': None}), (False, None))
                self.assertEqual(await self.write(kind, {**cleared, 'io.tavern.previous_event': '$legacy'}, '@member:local'), (False, None))
                self.assertEqual(await self.write(kind, {**cleared, 'io.tavern.previous_event': '$legacy'}), (True, None))
                self.server[(kind, '_member:local')] = event(kind, key='_member:local', body=cleared, eid='$canonical')
                self.assertEqual(read(self.server, kind, '@member:local').event_id, '$canonical')
                self.assertEqual(await self.write(kind, {**data, 'io.tavern.previous_event': '$legacy'}), (False, None))
                self.assertEqual(await self.write(kind, {**data, 'io.tavern.previous_event': '$canonical'}), (True, None))
                self.assertEqual(await self.write(kind, data), (False, None))

    def test_legacy_restrictions_remain_until_explicit_canonical_clear_without_fallback_on_malformed_state(self):
        for kind, check in ((TIMEOUT, timeout_active), (TEMPBAN, active)):
            state = {(kind, '@member:local'): event(kind, body={'version': 1, 'until': 1001})}
            self.assertTrue(check(state, '@member:local', 1000))
            state[(kind, '_member:local')] = event(kind, body={'version': 1, 'until': 0})
            self.assertFalse(check(state, '@member:local', 1000))
            state[(kind, '_member:local')].content = {}
            self.assertTrue(check(state, '@member:local', 1000))

    async def test_decoded_target_keeps_native_and_custom_hierarchy_including_v12_creators(self):
        for kind, data in ((TIMEOUT, {'until': 0}), (TEMPBAN, {'version': 1, 'until': 0}), (NICKNAME, {'version': 1, 'name': None})):
            for user in ('@mod:local', '@owner:local'):
                self.assertEqual(await self.write(kind, {**data, 'io.tavern.previous_event': None}, key(user)), (False, None))
            self.policy['members']['@member:local'] = ['mod']
            self.assertEqual(await self.write(kind, {**data, 'io.tavern.previous_event': None}), (False, None))
            self.policy['members'].pop('@member:local')

    async def test_filtered_parent_reads_include_canonical_and_legacy_for_actor_and_invited_target(self):
        captured = []
        self.room[('m.space.parent', '!server:local')] = event('m.space.parent', body={'canonical': True, 'via': ['local']})
        self.server[('m.space.child', '!channel:local')] = event('m.space.child', body={'via': ['local']})
        self.server[(TEMPBAN, '_member:local')] = event(TEMPBAN, body={'version': 1, 'until': int(time.time() * 1000) + 100000})
        async def filtered(room, filters=None):
            if filters is not None: captured.extend(filters)
            current = self.server if room == '!server:local' else self.room
            return {item: copy.deepcopy(value) for item, value in current.items() if filters is None or item in filters}
        self.module.api.get_room_state = filtered
        result = await self.module.check_event_allowed(event('m.room.member', sender='@mod:local', key='@member:local', body={'membership': 'invite'}), self.room)
        self.assertEqual(result, (False, None))
        for user in ('@mod:local', '@member:local'):
            self.assertIn((TEMPBAN, key(user)), captured)
            self.assertIn((TEMPBAN, user), captured)


if __name__ == '__main__': unittest.main()
