import unittest
from types import SimpleNamespace

from tests import test_roles as fixture
from api.room_authority import power, APIError
from synapse_modules.community_settings import NOTIFICATIONS, ONBOARDING


class CommunitySettingsTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.EventTests.asyncSetUp

    def welcome(self):
        return {'version': 1, 'enabled': True, 'startChannel': '!channel:local', 'welcomeChannel': '', 'rulesChannel': '!channel:local', 'recommended': ['!channel:local'], 'interests': [{'id': 'games', 'label': 'Games', 'channels': ['!channel:local']}]}

    async def setting(self, kind, body, *, actor='@owner:local', state=None, room='!server:local', key=''):
        return await self.module.check_event_allowed(fixture.event(kind, sender=actor, key=key, body=body, room=room), state if state is not None else self.server)

    async def test_welcome_requires_real_space_children_and_bounds_every_reference(self):
        self.server[('m.room.create', '')] = fixture.event('m.room.create', sender='@owner:local', body={'type': 'm.space', 'm.federate': False})
        self.assertEqual(await self.setting(ONBOARDING, self.welcome()), (True, None))
        for key in ('startChannel', 'welcomeChannel', 'rulesChannel', 'recommended', 'interests'):
            body = self.welcome()
            body[key] = ['!stranger:local'] if key == 'recommended' else [{'id': 'games', 'label': 'Games', 'channels': ['!stranger:local']}] if key == 'interests' else '!stranger:local'
            self.assertEqual(await self.setting(ONBOARDING, body), (False, None), key)
        body = self.welcome(); body['interests'] *= 13
        self.assertEqual(await self.setting(ONBOARDING, body), (False, None))
        self.assertEqual(await self.setting(ONBOARDING, self.welcome(), state=self.room, room='!channel:local'), (False, None))
        self.server[('m.space.child', '!channel:local')].content.clear()
        self.assertEqual(await self.setting(ONBOARDING, self.welcome()), (False, None))

    async def test_defaults_need_custom_server_or_channel_authority_with_category_restrictions(self):
        body = {'version': 1, 'mode': 'mentions'}
        self.assertEqual(await self.setting(NOTIFICATIONS, body, actor='@member:local'), (False, None))
        self.assertEqual(await self.setting(NOTIFICATIONS, body, actor='@mod:local'), (False, None))
        self.policy['roles'][1]['permissions'].append('manage_channels')
        self.assertEqual(await self.setting(NOTIFICATIONS, body, actor='@mod:local', state=self.room, room='!channel:local'), (True, None))
        self.policy['categoryOverrides'] = {'private': {'roles': {'mod': {'manage_channels': -1}}}}
        self.server[(fixture.policy_module.LAYOUT, '')] = fixture.event(fixture.policy_module.LAYOUT, body={'version': 1, 'categories': [{'id': 'private'}], 'channels': [{'id': '!channel:local', 'category': 'private'}]})
        self.assertEqual(await self.setting(NOTIFICATIONS, body, actor='@mod:local', state=self.room, room='!channel:local'), (False, None))
        self.policy['roles'][1]['permissions'].append('manage_server')
        self.assertEqual(await self.setting(NOTIFICATIONS, body, actor='@mod:local'), (True, None))

    async def test_invalid_shapes_and_stale_revisions_are_rejected_for_owners_too(self):
        current = fixture.event(NOTIFICATIONS, body={'version': 1, 'mode': 'all'}); current.event_id = '$current'
        self.server[(NOTIFICATIONS, '')] = current
        for body in ({'version': True, 'mode': 'all'}, {'version': 1, 'mode': []}, {'version': 1, 'mode': 'all', 'extra': 'invalid'}, {'version': 1, 'mode': 'mentions', 'io.tavern.previous_event': '$stale'}):
            self.assertEqual(await self.setting(NOTIFICATIONS, body), (False, None))
        self.assertEqual(await self.setting(NOTIFICATIONS, {'version': 1, 'mode': 'mentions', 'io.tavern.previous_event': '$current'}), (True, None))
        self.assertEqual(await self.setting(NOTIFICATIONS, {'version': 1, 'mode': 'all'}, key='stranger'), (False, None))

    async def test_settings_cannot_be_removed_through_redaction(self):
        for kind in (NOTIFICATIONS, ONBOARDING):
            async def lookup(*args, **kwargs): return fixture.event(kind, sender='@owner:local')
            self.module.api._store.get_event = lookup
            self.assertEqual(await self.setting('m.room.redaction', {'redacts': '$settings'}), (False, None))

    def test_companion_native_power_matches_canonical_native_model(self):
        state = {('m.room.create', ''): SimpleNamespace(sender='@creator:local', content={'room_version': '12', 'additional_creators': ['@coowner:local']})}
        for values in (None, {}, {'users': {'@moderator:local': 50}, 'users_default': 0}):
            if values is not None: state[('m.room.power_levels', '')] = SimpleNamespace(content=values)
            for user in ('@creator:local', '@coowner:local', '@moderator:local', '@member:local'):
                self.assertEqual(power(state, user), fixture.policy_module.native_member_power(state, user))
            self.assertEqual(power(state, '@creator:local'), float('inf'))
        state[('m.room.create', '')].content['room_version'] = '11'
        self.assertEqual(power(state, '@creator:local'), 0)
        del state[('m.room.power_levels', '')]
        self.assertEqual(power(state, '@creator:local'), 100)
        state[('m.room.power_levels', '')] = SimpleNamespace(content={'users_default': True})
        with self.assertRaises(APIError): power(state, '@member:local')


if __name__ == '__main__': unittest.main()
