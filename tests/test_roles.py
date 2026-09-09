import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('tavern_policy', Path(__file__).resolve().parents[1] / 'synapse_modules/tavern_policy.py')
policy_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy_module)

def policy():
    return {'version': 1, 'owner': '@owner:local', 'roles': [
        {'id': 'everyone', 'name': 'Member', 'position': 0, 'permissions': ['send_messages', 'add_reactions']},
        {'id': 'mod', 'name': 'Moderator', 'position': 50, 'permissions': ['manage_roles', 'manage_channels', 'kick', 'pin_messages']},
        {'id': 'admin', 'name': 'Admin', 'position': 90, 'permissions': list(policy_module.PERMISSIONS)},
    ], 'members': {'@mod:local': ['mod'], '@admin:local': ['admin']}, 'overrides': {}}

def event(kind, sender='@member:local', body=None, key=None, room='!channel:local', eid='$event'):
    return SimpleNamespace(type=kind, sender=sender, content=body or {}, state_key=key, room_id=room, event_id=eid)

class PolicyTests(unittest.TestCase):
    def test_denies_win_roles_user_override_wins_last(self):
        value = policy()
        value['overrides']['!channel:local'] = {'roles': {'everyone': {'send_messages': -1}, 'mod': {'send_messages': 1}}, 'users': {}}
        self.assertNotIn('send_messages', policy_module.permissions(value, '@mod:local', '!channel:local'))
        value['overrides']['!channel:local']['users']['@mod:local'] = {'send_messages': 1}
        self.assertIn('send_messages', policy_module.permissions(value, '@mod:local', '!channel:local'))

    def test_manager_cannot_promote_self_or_peer_above_rank(self):
        old, new = policy(), policy()
        new['members']['@mod:local'] = ['admin']
        self.assertFalse(policy_module.may_edit_policy(old, new, '@mod:local'))
        new = policy(); new['members']['@member:local'] = ['admin']
        self.assertFalse(policy_module.may_edit_policy(old, new, '@mod:local'))
        new = policy(); new['roles'][2]['name'] = 'Changed'
        self.assertFalse(policy_module.may_edit_policy(old, new, '@mod:local'))

    def test_manager_can_assign_lower_role(self):
        old = policy(); old['roles'].append({'id': 'helper', 'name': 'Helper', 'position': 10, 'permissions': ['pin_messages']})
        new = copy.deepcopy(old); new['members']['@member:local'] = ['helper']
        self.assertTrue(policy_module.may_edit_policy(old, new, '@mod:local'))

    def test_invalid_policy_and_owner_change_rejected(self):
        old, new = policy(), policy(); new['owner'] = '@mod:local'
        self.assertFalse(policy_module.may_edit_policy(old, new, '@owner:local'))
        new = policy(); new['roles'][1]['position'] = 0
        self.assertFalse(policy_module.valid_policy(new))

    def test_override_editor_cannot_grant_missing_power_or_modify_higher_role(self):
        old, new = policy(), policy()
        new['overrides']['!channel:local'] = {'roles': {'everyone': {'ban': 1}}, 'users': {}}
        self.assertFalse(policy_module.may_edit_policy(old, new, '@mod:local'))
        new = policy(); new['overrides']['!channel:local'] = {'roles': {'admin': {'send_messages': -1}}, 'users': {}}
        self.assertFalse(policy_module.may_edit_policy(old, new, '@mod:local'))

    def test_nested_untrusted_role_values_fail_without_throwing(self):
        value = policy(); value['roles'][0]['permissions'] = [{}]
        self.assertFalse(policy_module.valid_policy(value))
        value = policy(); value['members']['@member:local'] = [[]]
        self.assertFalse(policy_module.valid_policy(value))

class EventTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.policy = policy()
        self.server = {('io.tavern.roles', ''): event('io.tavern.roles', body=self.policy, key=''), ('m.space.child', '!channel:local'): event('m.space.child', body={'via': ['local']}, key='!channel:local')}
        self.room = {('m.space.parent', '!server:local'): event('m.space.parent', body={'canonical': True, 'via': ['local']}, key='!server:local', eid='$parent')}
        async def room_state(room, event_filter=None): return self.server
        async def lookup(target, allow_none=False): return self.room[('m.space.parent', '!server:local')] if target == '$parent' else event('m.room.message', sender='@member:local')
        async def account_data(user, kind): return {}
        api = SimpleNamespace(register_third_party_rules_callbacks=lambda **kwargs: None, get_room_state=room_state, _store=SimpleNamespace(get_event=lookup), is_mine=lambda user: True, account_data_manager=SimpleNamespace(get_global=account_data))
        self.module = policy_module.TavernPolicy({}, api)

    async def test_existing_unmanaged_rooms_unchanged(self):
        self.assertEqual(await self.module.check_event_allowed(event('m.room.message'), {}), (True, None))

    async def test_direct_encrypted_api_message_obeys_channel_deny(self):
        self.policy['overrides']['!channel:local'] = {'roles': {'everyone': {'send_messages': -1}}, 'users': {}}
        self.assertEqual(await self.module.check_event_allowed(event('m.room.encrypted'), self.room), (False, None))

    async def test_cannot_escape_policy_by_removing_or_redacting_parent(self):
        self.assertEqual(await self.module.check_event_allowed(event('m.space.parent', key='!server:local'), self.room), (False, None))
        self.assertEqual(await self.module.check_event_allowed(event('m.room.redaction', body={'redacts': '$parent'}), self.room), (False, None))

    async def test_owner_can_send_but_member_cannot_change_native_power(self):
        self.assertEqual(await self.module.check_event_allowed(event('m.room.power_levels'), self.room), (False, None))
        self.assertEqual(await self.module.check_event_allowed(event('m.room.encrypted', sender='@owner:local'), self.room), (True, None))

    async def test_native_self_profile_changes_still_work(self):
        self.assertEqual(await self.module.check_event_allowed(event('m.room.member', key='@member:local', body={'membership': 'join', 'displayname': 'Name'}), self.room), (True, None))

    async def test_invitation_does_not_require_higher_role_than_invitee(self):
        self.policy['roles'][0]['permissions'].append('invite')
        self.assertEqual(await self.module.check_event_allowed(event('m.room.member', key='@new:local', body={'membership': 'invite'}), self.room), (True, None))

    async def test_blocked_inviter_is_rejected_even_in_unmanaged_room(self):
        async def ignored(user, kind): return {'ignored_users': {'@member:local': {}}}
        self.module.api.account_data_manager.get_global = ignored
        self.assertEqual(await self.module.check_event_allowed(event('m.room.member', key='@new:local', body={'membership': 'invite'}), {}), (False, None))

    async def test_first_policy_requires_actual_space_creator_and_nonfederated_room(self):
        create = event('m.room.create', sender='@owner:local', key='', body={'type': 'm.space', 'm.federate': False})
        state = {('m.room.create', ''): create}
        self.assertEqual(await self.module.check_event_allowed(event('io.tavern.roles', sender='@owner:local', key='', body=self.policy), state), (True, None))
        self.assertEqual(await self.module.check_event_allowed(event('io.tavern.roles', sender='@attacker:local', key='', body=self.policy), state), (False, None))
        create.content['m.federate'] = True
        self.assertEqual(await self.module.check_event_allowed(event('io.tavern.roles', sender='@owner:local', key='', body=self.policy), state), (False, None))

    async def test_fake_one_way_parent_does_not_inherit_server(self):
        self.server.pop(('m.space.child', '!channel:local'))
        self.assertEqual(await self.module.check_event_allowed(event('m.room.power_levels'), self.room), (True, None))

if __name__ == '__main__': unittest.main()
