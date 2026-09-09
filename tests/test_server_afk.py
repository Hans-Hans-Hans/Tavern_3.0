import copy
import unittest
from types import SimpleNamespace
from tests import test_roles as fixture
from synapse_modules.server_afk import AFK, ServerAfkPolicy, valid_afk

SERVER, VOICE, OWNER = '!server:local', '!voice:local', '@owner:local'


class ServerAfkTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixture.EventTests.asyncSetUp(self)
        self.server[('m.room.create', '')] = fixture.event('m.room.create', sender=OWNER, body={'type': 'm.space', 'm.federate': False})
        self.server[('m.space.child', VOICE)] = fixture.event('m.space.child', body={'via': ['local']})
        self.voice = {
            ('m.room.create', ''): fixture.event('m.room.create', body={'m.federate': False}),
            ('m.room.encryption', ''): fixture.event('m.room.encryption', body={'algorithm': 'm.megolm.v1.aes-sha2'}),
            ('io.tavern.channel', ''): fixture.event('io.tavern.channel', body={'version': 1, 'kind': 'voice', 'archived': False, 'slowModeSeconds': 0}),
            ('m.space.parent', SERVER): fixture.event('m.space.parent', body={'canonical': True, 'via': ['local']}),
            ('m.room.member', OWNER): fixture.event('m.room.member', body={'membership': 'join'}),
        }
        for user in (OWNER, '@mod:local', '@member:local'):
            self.server[('m.room.member', user)] = fixture.event('m.room.member', body={'membership': 'join'})
            self.voice[('m.room.member', user)] = fixture.event('m.room.member', body={'membership': 'join'})
        async def state(identity, *args): return self.voice if identity == VOICE else self.server if identity == SERVER else {}
        self.module.api.get_room_state = state

    def settings(self, **changes): return {'version': 1, 'channelId': VOICE, 'timeoutSeconds': 300, 'io.tavern.previous_event': None, **changes}

    async def allowed(self, value=None, actor=OWNER):
        event = fixture.event(AFK, sender=actor, room=SERVER, key='', body=self.settings() if value is None else value)
        return await self.module.check_event_allowed(event, self.server)

    async def test_destination_requires_reciprocal_encrypted_voice_channel_and_membership(self):
        self.assertEqual(await self.allowed(), (True, None))
        original = copy.deepcopy(self.voice)
        for kind, data in [('m.room.create', {'m.federate': True}), ('m.room.create', {'m.federate': False, 'type': 'io.tavern.private_thread'}), ('m.room.encryption', {}), ('io.tavern.channel', {'kind': 'text'}), ('io.tavern.channel', {'kind': 'voice', 'archived': True}), ('m.room.tombstone', {'replacement_room': '!new:local'})]:
            self.voice = copy.deepcopy(original); self.voice[(kind, '')] = fixture.event(kind, body=data)
            self.assertEqual(await self.allowed(), (False, None), kind)
        self.voice = copy.deepcopy(original); self.voice[('m.space.parent', SERVER)].content = {'via': ['local']}
        self.assertEqual(await self.allowed(), (False, None))
        self.voice = copy.deepcopy(original); self.voice[('m.room.member', OWNER)].content = {'membership': 'leave'}
        self.assertEqual(await self.allowed(), (False, None))
        self.voice = original; self.server[('m.space.child', VOICE)].content = {}
        self.assertEqual(await self.allowed(), (False, None))

    async def test_native_requests_also_need_current_custom_server_authority(self):
        self.assertEqual(await self.allowed(actor='@member:local'), (False, None))
        self.assertEqual(await self.allowed(actor='@mod:local'), (False, None))
        self.policy['roles'][1]['permissions'].append('manage_server')
        self.assertEqual(await self.allowed(actor='@mod:local'), (True, None))
        self.server[('m.room.member', '@mod:local')].content = {'membership': 'leave'}
        self.assertEqual(await self.allowed(actor='@mod:local'), (False, None))

    async def test_revision_required_for_every_write_and_disabled_configuration_is_valid(self):
        self.assertEqual(await self.allowed(self.settings(channelId='')), (True, None))
        missing = self.settings(); del missing['io.tavern.previous_event']
        self.assertEqual(await self.allowed(missing), (False, None))
        self.server[(AFK, '')] = fixture.event(AFK, body=self.settings(), eid='$latest')
        self.assertEqual(await self.allowed(), (False, None))
        self.assertEqual(await self.allowed(self.settings(**{'io.tavern.previous_event': '$latest'})), (True, None))

    async def test_no_federated_server_or_channel_setting_and_protected_redaction(self):
        self.server[('m.room.create', '')].content['m.federate'] = True
        self.assertEqual(await self.allowed(), (False, None))
        self.server[('m.room.create', '')].content = {'m.federate': False}
        self.assertEqual(await self.allowed(), (False, None))
        async def lookup(*args, **kwargs): return fixture.event(AFK)
        self.module.api._store.get_event = lookup
        self.assertEqual(await self.module.check_event_allowed(fixture.event('m.room.redaction', body={'redacts': '$afk'}), {}), (False, None))

    def test_bounded_schema_rejects_unknown_keys_bool_timeout_and_unsafe_ids(self):
        for changes in ({'version': True}, {'timeoutSeconds': True}, {'timeoutSeconds': 301}, {'timeoutSeconds': 86400}, {'channelId': 'https://other'}, {'channelId': '!x\x7f'}, {'channelId': '!x y'}, {'channelId': '!'+ 'x'*255}, {'moveMembers': True}):
            self.assertFalse(valid_afk(self.settings(**changes)), changes)


if __name__ == '__main__': unittest.main()
