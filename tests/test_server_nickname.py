import copy
import time
import unittest

from tests import test_roles as fixture
from synapse_modules.server_nickname import NICKNAME


class ServerNicknamePolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixture.EventTests.asyncSetUp(self)
        self.policy['roles'][1]['permissions'].append('manage_nicknames')
        self.server[('m.room.create', '')] = fixture.event('m.room.create', sender='@owner:local', body={'type': 'm.space', 'm.federate': False, 'room_version': '11'})
        self.server[('m.room.power_levels', '')] = fixture.event('m.room.power_levels', body={'users': {'@owner:local': 100, '@mod:local': 50, '@admin:local': 75}, 'users_default': 0, 'state_default': 50})
        for user in ('@owner:local', '@mod:local', '@admin:local', '@member:local'):
            self.server[('m.room.member', user)] = fixture.event('m.room.member', sender=user, key=user, body={'membership': 'join', 'displayname': 'Member chosen name'})

    async def write(self, *, actor='@mod:local', target='@member:local', body=None, state=None, room='!server:local'):
        return await self.module.check_event_allowed(fixture.event(NICKNAME, sender=actor, key=target, room=room,
            body=body if body is not None else {'version': 1, 'name': 'Server nickname', 'io.tavern.previous_event': None}), self.server if state is None else state)

    async def test_set_and_clear_require_exact_previous_event_without_changing_membership(self):
        before = copy.deepcopy(self.server[('m.room.member', '@member:local')].content)
        self.assertEqual(await self.write(), (True, None))
        current = fixture.event(NICKNAME, sender='@mod:local', key='@member:local', body={'version': 1, 'name': 'Server nickname'}, eid='$nickname')
        self.server[(NICKNAME, '@member:local')] = current
        self.assertEqual(await self.write(body={'version': 1, 'name': None, 'io.tavern.previous_event': '$nickname'}), (True, None))
        self.assertEqual(await self.write(), (False, None))
        self.assertEqual(await self.write(body={'version': 1, 'name': 'Other', 'io.tavern.previous_event': '$stale'}), (False, None))
        self.assertEqual(self.server[('m.room.member', '@member:local')].content, before)

    async def test_native_permission_and_both_native_and_custom_hierarchies_are_required(self):
        self.assertEqual(await self.write(target='@mod:local'), (False, None))
        self.assertEqual(await self.write(target='@admin:local'), (False, None))
        self.assertEqual(await self.write(target='@owner:local'), (False, None))
        powers = self.server[('m.room.power_levels', '')].content
        powers['users']['@member:local'] = 50
        self.assertEqual(await self.write(), (False, None))
        powers['users']['@member:local'] = 0
        self.policy['members']['@member:local'] = ['mod']
        self.assertEqual(await self.write(), (False, None))
        del self.policy['members']['@member:local']
        powers['events'] = {NICKNAME: 75}
        self.assertEqual(await self.write(), (False, None))
        self.assertEqual(await self.write(actor='@owner:local'), (True, None))
        powers['events'][NICKNAME] = True
        self.assertEqual(await self.write(actor='@owner:local'), (False, None))

    async def test_owner_cannot_bypass_native_peer_or_v12_creator_protection(self):
        powers = self.server[('m.room.power_levels', '')].content
        powers['users']['@member:local'] = 100
        self.assertEqual(await self.write(actor='@owner:local'), (False, None))
        powers['users']['@member:local'] = 0
        creation = self.server[('m.room.create', '')].content
        creation.update(room_version='12', additional_creators=['@member:local'])
        self.assertEqual(await self.write(actor='@owner:local'), (False, None))
        self.assertEqual(await self.write(actor='@owner:local', target='@mod:local'), (True, None))

    async def test_revoked_permission_membership_and_restricted_moderator_fail_closed(self):
        self.policy['roles'][1]['permissions'].remove('manage_nicknames')
        self.assertEqual(await self.write(), (False, None))
        self.policy['roles'][1]['permissions'].append('manage_nicknames')
        for user in ('@mod:local', '@member:local'):
            member = self.server[('m.room.member', user)].content
            member['membership'] = 'leave'
            self.assertEqual(await self.write(), (False, None))
            member['membership'] = 'join'
        for kind in ('io.tavern.timeout', 'io.tavern.tempban'):
            self.server[(kind, '@mod:local')] = fixture.event(kind, body={'version': 1, 'until': int(time.time() * 1000) + 60000})
            self.assertEqual(await self.write(), (False, None))
            del self.server[(kind, '@mod:local')]

    async def test_override_only_applies_to_managed_nonfederated_space_and_server_permission(self):
        self.assertEqual(await self.write(state=self.room, room='!channel:local'), (False, None))
        self.assertEqual(await self.write(state={}), (False, None))
        creation = self.server[('m.room.create', '')].content
        creation['m.federate'] = True
        self.assertEqual(await self.write(), (False, None))
        creation['m.federate'] = False
        creation['type'] = 'ordinary-room'
        self.assertEqual(await self.write(), (False, None))
        self.policy['overrides']['!channel:local'] = {'users': {'@member:local': {'manage_nicknames': 1}}}
        self.assertFalse(fixture.policy_module.valid_policy(self.policy))

    async def test_invalid_shapes_names_and_missing_revision_are_rejected_even_for_owner(self):
        values = [{'version': True, 'name': 'Name', 'io.tavern.previous_event': None}, {'version': 1, 'name': 'Name'},
                  {'version': 1, 'name': 'Name', 'io.tavern.previous_event': None, 'avatar_url': 'mxc://other/icon'}]
        values += [{'version': 1, 'name': name, 'io.tavern.previous_event': None} for name in ('', ' padded ', 'line\nbreak', 'x' * 61, {}, True)]
        for value in values:
            with self.subTest(value=value):
                self.assertEqual(await self.write(actor='@owner:local', body=value), (False, None))
        for target in ('not-an-account', '@member:local\n', '@' + 'a' * 255 + ':local'):
            self.assertEqual(await self.write(actor='@owner:local', target=target), (False, None))

    async def test_redaction_cannot_remove_override_and_self_profile_edits_still_work(self):
        async def original(*args, **kwargs): return fixture.event(NICKNAME, sender='@mod:local', key='@member:local')
        self.module.api._store.get_event = original
        for actor in ('@mod:local', '@member:local', '@owner:local'):
            result = await self.module.check_event_allowed(fixture.event('m.room.redaction', sender=actor, room='!server:local', body={'redacts': '$nickname'}), self.server)
            self.assertEqual(result, (False, None))
        result = await self.module.check_event_allowed(fixture.event('m.room.member', sender='@member:local', key='@member:local', room='!server:local', body={'membership': 'join', 'displayname': 'My own name'}), self.server)
        self.assertEqual(result, (True, None))


if __name__ == '__main__':
    unittest.main()
