import copy
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from api.rtc_authority import CALL_MEMBER, call_authority
from api.room_authority import RoomAuthority
from api.server import APIError
from synapse_modules import tavern_policy as model


def event(value, sender='@owner:test'):
    return SimpleNamespace(content=value, sender=sender, event_id='$state')


class RtcAuthorityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.user, self.room, self.parent = '@alice:test', '!voice:test', '!server:test'
        self.current = {
            ('m.room.create', ''): event({'m.federate': False}),
            ('m.room.encryption', ''): event({'algorithm': 'm.megolm.v1.aes-sha2'}),
            ('m.room.member', self.user): event({'membership': 'join'}),
            ('m.room.power_levels', ''): event({'users': {'@owner:test': 100}, 'events': {CALL_MEMBER: 0}}),
        }
        self.policy = {'version': 1, 'owner': '@owner:test', 'roles': [{'id': 'everyone', 'name': 'Member', 'position': 0, 'permissions': ['join_calls']}], 'members': {}, 'overrides': {}, 'categoryOverrides': {}}
        self.parent_state = {('m.room.member', self.user): event({'membership': 'join'})}
        self.layout = {'version': 1, 'categories': [], 'channels': []}
        self.eligibility = AsyncMock()

    async def check(self):
        policy = model.ResolvedPolicy(self.policy, self.layout)
        authority = RoomAuthority(self.room, self.user, self.current, [(self.parent, policy, self.parent_state)], model)
        with patch('api.rtc_authority.room_authority', AsyncMock(return_value=authority)), patch('api.rtc_authority.require_room_eligibility', self.eligibility):
            return await call_authority(None, {'user_id': self.user}, self.room)

    async def test_native_and_custom_permission_both_allow_member(self):
        self.assertEqual((await self.check()).actor, self.user)
        self.eligibility.assert_awaited_once_with(None, {'user_id': self.user}, self.room, self.current)

    async def test_server_eligibility_is_an_additional_required_admission_check(self):
        self.eligibility.side_effect = APIError(403, 'Verify your email address.', 'SERVER_ELIGIBILITY_REQUIRED')
        with self.assertRaises(APIError) as denied:
            await self.check()
        self.assertEqual(denied.exception.code, 'SERVER_ELIGIBILITY_REQUIRED')

    async def test_native_power_remains_a_ceiling(self):
        self.current[('m.room.power_levels', '')].content['events'][CALL_MEMBER] = 50
        with self.assertRaises(APIError): await self.check()

    async def test_room_version_twelve_creator_native_power_is_preserved(self):
        self.current[('m.room.create', '')] = event({'m.federate': False, 'room_version': '12'}, self.user)
        self.current[('m.room.power_levels', '')].content['events'][CALL_MEMBER] = 1000
        await self.check()

    async def test_room_and_category_denies_are_applied(self):
        self.policy['overrides'] = {self.room: {'roles': {}, 'users': {self.user: {'join_calls': -1}}}}
        with self.assertRaises(APIError): await self.check()
        self.policy['overrides'] = {}
        self.layout = {'version': 1, 'categories': [{'id': 'social', 'name': 'Social'}], 'channels': [{'id': self.room, 'category': 'social'}]}
        self.policy['categoryOverrides'] = {'social': {'roles': {'everyone': {'join_calls': -1}}, 'users': {}}}
        with self.assertRaises(APIError): await self.check()

    async def test_missing_parent_membership_blocks_retained_channel_membership(self):
        self.parent_state[('m.room.member', self.user)].content['membership'] = 'leave'
        with self.assertRaises(APIError): await self.check()

    async def test_archive_timeout_and_temporary_bans_fail_closed(self):
        for scope, kind, value in [
            (self.current, 'io.tavern.channel', {'version': 1, 'kind': 'voice', 'archived': True}),
            (self.current, 'io.tavern.timeout', {'until': int(time.time() * 1000) + 60000}),
            (self.parent_state, 'io.tavern.timeout', {'until': 'invalid'}),
            (self.parent_state, 'io.tavern.tempban', {}),
        ]:
            key = '' if kind == 'io.tavern.channel' else self.user
            scope[(kind, key)] = event(value)
            with self.assertRaises(APIError): await self.check()
            del scope[(kind, key)]

    async def test_private_discussions_spaces_federation_and_tombstones_are_not_call_admission(self):
        initial = copy.deepcopy(self.current)
        for creation in ({'m.federate': True}, {'m.federate': False, 'type': 'm.space'}, {'m.federate': False, 'type': 'io.tavern.private_thread'}):
            self.current[('m.room.create', '')] = event(creation)
            with self.assertRaises(APIError): await self.check()
        self.current = initial
        self.current[('m.room.tombstone', '')] = event({})
        with self.assertRaises(APIError): await self.check()


if __name__ == '__main__': unittest.main()
