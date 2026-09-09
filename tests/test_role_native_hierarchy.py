import copy
import unittest

from tests import test_roles as fixture


class NativeRoleHierarchyTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.EventTests.asyncSetUp

    def managed_state(self):
        self.policy['roles'].append({'id': 'tag', 'name': 'Tag', 'position': 1, 'permissions': []})
        return {('m.room.create', ''): fixture.event('m.room.create', sender='@owner:local', key='', body={'type': 'm.space', 'm.federate': False, 'room_version': '11'}),
                ('m.room.power_levels', ''): fixture.event('m.room.power_levels', key='', body={'users': {'@owner:local': 100, '@mod:local': 50, '@nativeadmin:local': 100, '@nativepeer:local': 50}}),
                (fixture.policy_module.POLICY, ''): fixture.event(fixture.policy_module.POLICY, key='', body=self.policy)}

    async def write(self, state, proposed, actor='@mod:local'):
        return await self.module.check_event_allowed(fixture.event(fixture.policy_module.POLICY, sender=actor, key='', body=proposed), state)

    async def test_native_equal_higher_members_are_protected_even_with_low_custom_rank(self):
        state = self.managed_state()
        for target in ('@nativeadmin:local', '@nativepeer:local'):
            proposed = copy.deepcopy(self.policy); proposed['members'][target] = ['tag']
            self.assertTrue(fixture.policy_module.may_edit_policy(self.policy, proposed, '@mod:local'))
            self.assertEqual(await self.write(state, proposed), (False, None))
        proposed = copy.deepcopy(self.policy); proposed['members']['@member:local'] = ['tag']
        self.assertEqual(await self.write(state, proposed), (True, None))

    async def test_removing_assignment_is_protected_but_deleted_role_cleanup_is_allowed(self):
        state = self.managed_state(); self.policy['members']['@nativeadmin:local'] = ['tag']
        proposed = copy.deepcopy(self.policy); proposed['members']['@nativeadmin:local'] = []
        self.assertEqual(await self.write(state, proposed), (False, None))
        proposed['roles'] = [role for role in proposed['roles'] if role['id'] != 'tag']
        self.assertEqual(await self.write(state, proposed), (True, None))
        proposed['members']['@nativeadmin:local'] = ['mod']
        self.assertEqual(await self.write(state, proposed), (False, None))

    async def test_room_creator_fallback_and_v12_creators_have_native_authority(self):
        state = self.managed_state(); del state[('m.room.power_levels', '')]
        proposed = copy.deepcopy(self.policy); proposed['members']['@member:local'] = ['tag']
        self.assertEqual(await self.write(state, proposed, '@owner:local'), (True, None))
        self.assertEqual(await self.write(state, proposed), (False, None))
        state[('m.room.create', '')].content.update(room_version='12', additional_creators=['@coowner:local'])
        state[('m.room.power_levels', '')] = fixture.event('m.room.power_levels', body={'users': {'@mod:local': 50}})
        self.assertEqual(fixture.policy_module.native_member_power(state, '@owner:local'), float('inf'))
        self.assertEqual(fixture.policy_module.native_member_power(state, '@coowner:local'), float('inf'))
        self.assertEqual(await self.write(state, proposed, '@owner:local'), (True, None))
        proposed['members']['@coowner:local'] = ['tag']
        self.assertEqual(await self.write(state, proposed, '@owner:local'), (False, None))

    async def test_initial_role_policy_cannot_assign_to_native_equal_creator_peer(self):
        state = self.managed_state(); del state[(fixture.policy_module.POLICY, '')]
        proposed = copy.deepcopy(self.policy); proposed['members']['@nativeadmin:local'] = ['tag']
        self.assertEqual(await self.write(state, proposed, '@owner:local'), (False, None))
        del proposed['members']['@nativeadmin:local']
        self.assertEqual(await self.write(state, proposed, '@owner:local'), (True, None))

    async def test_member_assignment_guard_does_not_replace_the_native_policy_event_threshold(self):
        state = self.managed_state(); state[('m.room.power_levels', '')].content['events'] = {fixture.policy_module.POLICY: 100}
        proposed = copy.deepcopy(self.policy); proposed['members']['@member:local'] = ['tag']
        # The module's extra restrictions pass; native Matrix event auth still
        # rejects an actor at 50 writing a policy event requiring 100.
        self.assertEqual(await self.write(state, proposed), (True, None))
        self.assertEqual(state[('m.room.power_levels', '')].content['users']['@mod:local'], 50)


if __name__ == '__main__': unittest.main()
