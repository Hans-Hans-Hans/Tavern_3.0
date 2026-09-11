import copy
import unittest
from tests import test_roles as fixture

event, policy_module = fixture.event, fixture.policy_module


class ChannelRoleRecipeTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.EventTests.asyncSetUp

    async def test_native_call_membership_uses_category_deny_then_channel_role_allow(self):
        self.policy['roles'][0]['permissions'].append('join_calls')
        self.policy['roles'].append({'id': 'gamer', 'name': 'Gamer', 'position': 10, 'permissions': []})
        self.policy['members']['@gamer:local'] = ['gamer']
        self.policy['categoryOverrides'] = {'games': {'roles': {'everyone': {'join_calls': -1}}, 'users': {}}}
        self.policy['overrides']['!channel:local'] = {'roles': {'gamer': {'join_calls': 1}}, 'users': {}}
        layout = {'version': 1, 'categories': [{'id': 'games'}], 'channels': [{'id': '!channel:local', 'category': 'games'}]}
        self.server[(policy_module.LAYOUT, '')] = event(policy_module.LAYOUT, body=layout)
        # The actual native third-party rule sees call membership state, rather
        # than trusting a UI label or a separate permission implementation.
        def call(sender):
            return event('org.matrix.msc3401.call.member', sender=sender, key=sender,
                         body={'memberships': [{'application': 'm.call', 'scope': 'm.room', 'device_id': 'DEVICE', 'call_id': ''}]})
        self.assertEqual(await self.module.check_event_allowed(call('@gamer:local'), copy.deepcopy(self.room)), (True, None))
        self.assertEqual(await self.module.check_event_allowed(call('@member:local'), copy.deepcopy(self.room)), (False, None))
        self.policy['overrides']['!channel:local']['roles']['everyone'] = {'join_calls': -1}
        self.assertEqual(await self.module.check_event_allowed(call('@gamer:local'), copy.deepcopy(self.room)), (False, None))
