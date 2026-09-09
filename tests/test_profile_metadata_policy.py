from collections.abc import Mapping
import copy
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from synapse_modules.profile_metadata_policy import PROFILE_POLICY, PROFILE, ProfilePolicyDenied, profile_error, valid_settings
from tests import test_roles as fixture

OWNER, MEMBER, SERVER, ROOM = '@owner:local', '@member:local', '!server:local', '!channel:local'


def settings(**changes):
    return {'version': 1, 'enabled': True, 'allowLinks': True, 'allowCustomFields': True,
            'maxBioLength': 1000, 'maxStatusLength': 160, 'io.tavern.previous_event': None, **changes}


def profile(**changes):
    return {'version': 1, 'bio': 'A member biography', 'status': 'Available', 'links': [], 'fields': [], **changes}


class NativeMapping(Mapping):
    def __init__(self, values): self.values = values
    def __getitem__(self, key): return self.values[key]
    def __iter__(self): return iter(self.values)
    def __len__(self): return len(self.values)
    def __deepcopy__(self, memo): raise TypeError('Native Mapping cannot be copied')


class ProfileMetadataTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixture.EventTests.asyncSetUp(self)
        self.server[('m.room.create', '')] = fixture.event('m.room.create', sender=OWNER, body={'type': 'm.space', 'm.federate': False})
        self.room[('m.room.create', '')] = fixture.event('m.room.create', sender=OWNER, body={'m.federate': False})
        self.room[('m.room.encryption', '')] = fixture.event('m.room.encryption', body={'algorithm': 'm.megolm.v1.aes-sha2'})
        self.server[('m.room.power_levels', '')] = fixture.event('m.room.power_levels', body={'users': {OWNER: 100, '@admin:local': 50}, 'state_default': 50})
        for actor in (OWNER, MEMBER, '@admin:local'):
            for state in (self.server, self.room):
                state[('m.room.member', actor)] = fixture.event('m.room.member', key=actor, sender=actor, body={'membership': 'join'})
        self.states = {SERVER: self.server, ROOM: self.room}
        async def current(room, *args): return self.states.get(room, {})
        self.module.api.get_room_state = current
        self.checker = self.module.profile_metadata

    def enable(self, **changes):
        self.server[(PROFILE_POLICY, '')] = fixture.event(PROFILE_POLICY, body=settings(**changes), key='', room=SERVER, eid='$profile-policy')

    async def allowed(self, kind='m.room.member', body=None, actor=MEMBER, key=MEMBER, room=ROOM, state=None):
        if body is None: body = {'membership': 'join', PROFILE: profile()}
        try:
            return (await self.module.check_event_allowed(fixture.event(kind, sender=actor, key=key, room=room, body=body), self.room if state is None else state))[0]
        except ProfilePolicyDenied:
            return False

    async def publish(self, data): return await self.allowed(body={'membership': 'join', PROFILE: data})

    async def test_absent_and_disabled_policy_preserve_legacy_profile_behavior(self):
        self.assertTrue(await self.publish({'legacy': 'previous client metadata'}))
        self.enable(enabled=False, allowLinks=False, maxBioLength=0)
        self.assertTrue(await self.publish({'legacy': 'previous client metadata'}))

    async def test_native_self_join_profile_publication_cannot_bypass_early_membership_return(self):
        self.enable(allowLinks=False, allowCustomFields=False, maxBioLength=160, maxStatusLength=40)
        self.assertTrue(await self.publish(profile()))
        self.assertFalse(await self.publish(profile(links=[{'label': 'Site', 'url': 'https://example.com/'}])))
        self.assertFalse(await self.publish(profile(fields=[{'label': 'Project', 'value': 'Example'}])))
        self.assertFalse(await self.publish(profile(bio='x' * 161)))
        self.assertFalse(await self.publish(profile(status='x' * 41)))

    async def test_basic_join_extension_removal_and_self_leave_remain_allowed(self):
        self.enable(allowLinks=False, allowCustomFields=False, maxBioLength=0, maxStatusLength=0)
        self.assertTrue(await self.allowed(body={'membership': 'join', 'displayname': 'Basic native profile'}))
        self.assertTrue(await self.publish({'version': 1}))
        self.assertTrue(await self.allowed(body={'membership': 'leave', PROFILE: {'old': 'invalid profile remains in prior event'}}))
        self.server[(PROFILE_POLICY, '')].content = {}
        self.assertTrue(await self.allowed(body={'membership': 'join'}))
        self.assertFalse(await self.publish(profile()))

    async def test_zero_status_limit_rejects_emoji_only_status_but_allows_clearing_it(self):
        self.enable(maxStatusLength=0)
        self.assertFalse(await self.publish(profile(status='', statusEmoji='\U0001f600')))
        self.assertTrue(await self.publish(profile(status='', statusEmoji='', statusUntil=0)))
        self.assertTrue(await self.allowed(body={'membership': 'join'}))
        self.assertTrue(await self.allowed(body={'membership': 'leave', PROFILE: profile(status='', statusEmoji='\U0001f600')}))
        item = fixture.event('m.room.member', key=MEMBER, body={'membership': 'join', PROFILE: profile(status='', statusEmoji='\U0001f600')})
        with self.assertRaisesRegex(ProfilePolicyDenied, 'Remove the status emoji'):
            await self.checker.check(item, self.room)

    async def test_http_urls_are_bounded_and_credentials_relative_schemes_and_backslashes_rejected(self):
        self.enable()
        for url in ('https://example.com/', 'http://localhost:8080/profile', 'https://[::1]:8443/a?b=1#c'):
            self.assertTrue(await self.publish(profile(links=[{'label': '', 'url': url}])), url)
        for url in ('javascript:alert(1)', 'data:text/plain,hello', '/relative', '//example.com/', 'https://user:pass@example.com/',
                    'https://@example.com/', 'https://example.com\\@other.test/', 'https://example.com:99999/', 'https://a.test/\nnext', 'https://a.test/' + 'x' * 1000):
            self.assertFalse(await self.publish(profile(links=[{'label': 'Site', 'url': url}])), url)

    async def test_strict_extension_schema_and_image_status_and_override_bounds(self):
        self.enable()
        for data in (profile(version=True), profile(unknown=True), profile(links={}), profile(fields=[{'label': '', 'value': 'value'}]),
                     profile(avatar='https://example.com/avatar.png'), profile(banner='mxc://user:password@server/media'),
                     profile(statusUntil=True), profile(statusUntil=2 ** 53), profile(accent='red'), profile(serverOverride=SERVER),
                     profile(bio='nul\x00'), profile(name='x' * 61), profile(links=[{'label': 'A', 'url': 'https://a.test'}] * 6),
                     profile(fields=[{'label': 'A', 'value': 'b'}] * 9)):
            self.assertFalse(await self.publish(data), repr(data)[:100])
        self.assertTrue(await self.publish(profile(avatar='mxc://server.test/media', banner='', accent='#Aa09fE', statusUntil=9007199254740991)))
        self.assertTrue(await self.allowed(body={'membership': 'join', PROFILE: profile(serverOverride=SERVER)}, state=self.server, room=SERVER))

    async def test_utf16_limits_match_browser_lengths_including_astral_unicode(self):
        self.enable(maxBioLength=160, maxStatusLength=40)
        self.assertTrue(await self.publish(profile(bio='😀' * 80, status='😀' * 20)))
        self.assertFalse(await self.publish(profile(bio='😀' * 81)))
        self.assertFalse(await self.publish(profile(status='😀' * 21)))
        self.assertFalse(await self.publish(profile(bio='\ud800')))

    async def test_rules_apply_to_each_reciprocal_canonical_parent_including_roleless_space(self):
        self.enable(allowLinks=True)
        second = copy.deepcopy(self.server)
        del second[(fixture.policy_module.POLICY, '')]
        second[(PROFILE_POLICY, '')].content = settings(allowLinks=False)
        self.states['!second:local'] = second
        self.room[('m.space.parent', '!second:local')] = fixture.event('m.space.parent', body={'canonical': True, 'via': ['local']})
        data = profile(links=[{'label': 'Site', 'url': 'https://example.com/'}])
        self.assertFalse(await self.publish(data))
        second[('m.space.child', ROOM)].content = {}
        self.assertTrue(await self.publish(data), 'A one-sided parent claim is not policy authority')
        second[('m.space.child', ROOM)].content = {'via': ['local']}
        self.room[('m.space.parent', '!second:local')].content['canonical'] = False
        self.assertTrue(await self.publish(data))

    async def test_policy_enable_stricter_edit_and_new_parent_during_lookup_reject_stale_context(self):
        previous = copy.deepcopy(self.room)
        async def enable_on_current(room, *args):
            if room == ROOM: self.enable(allowLinks=False)
            return self.states.get(room, {})
        self.module.api.get_room_state = enable_on_current
        self.assertFalse(await self.allowed(body={'membership': 'join', PROFILE: profile(links=[{'label': 'Site', 'url': 'https://example.com/'}])}, state=previous))
        self.enable()
        async def change_own(room, *args):
            if room == SERVER: self.enable(maxBioLength=0)
            return self.states.get(room, {})
        self.module.api.get_room_state = change_own
        self.assertFalse(await self.allowed(state=copy.deepcopy(self.server), room=SERVER))
        self.enable()
        second = copy.deepcopy(self.server); second[(PROFILE_POLICY, '')].content = settings(maxBioLength=0)
        self.states['!second:local'] = second
        async def add_parent(room, *args):
            if room == ROOM: self.room[('m.space.parent', '!second:local')] = fixture.event('m.space.parent', body={'canonical': True, 'via': ['local']})
            return self.states.get(room, {})
        self.module.api.get_room_state = add_parent
        self.assertFalse(await self.allowed(state=previous))

    async def test_private_discussion_uses_immutable_source_and_detects_binding_change(self):
        self.enable(allowCustomFields=False)
        private = {('m.room.create', ''): fixture.event('m.room.create', body={'type': 'io.tavern.private_thread', 'm.federate': False,
            'io.tavern.private_thread': {'version': 1, 'source_room_id': ROOM, 'source_event_id': ''}})}
        self.states['!private:local'] = copy.deepcopy(private)
        item = fixture.event('m.room.member', key=MEMBER, room='!private:local', body={'membership': 'join', PROFILE: profile(fields=[{'label': 'A', 'value': 'B'}])})
        with self.assertRaises(ProfilePolicyDenied): await self.checker.check(item, private)
        item.content[PROFILE] = profile()
        self.assertTrue(await self.checker.check(item, private))
        self.states['!private:local'][('m.room.create', '')].content['io.tavern.private_thread']['source_event_id'] = '$changed'
        with self.assertRaises(ProfilePolicyDenied): await self.checker.check(item, private)

    async def test_policy_settings_require_native_custom_membership_and_exact_revision(self):
        async def write(actor, data):
            return await self.allowed(PROFILE_POLICY, data, actor=actor, key='', room=SERVER, state=self.server)
        self.assertTrue(await write(OWNER, settings()))
        self.assertFalse(await write(MEMBER, settings()))
        self.assertTrue(await write('@admin:local', settings()))
        self.server[('m.room.power_levels', '')].content['users']['@admin:local'] = 0
        self.assertFalse(await write('@admin:local', settings()))
        self.server[('m.room.power_levels', '')].content['users'][MEMBER] = 100
        self.assertFalse(await write(MEMBER, settings()), 'Native power cannot replace manage_server')
        self.enable()
        self.assertFalse(await write(OWNER, settings()))
        current = settings(**{'io.tavern.previous_event': '$profile-policy'})
        self.assertTrue(await write(OWNER, current))
        self.server[('m.room.member', OWNER)].content['membership'] = 'leave'
        self.assertFalse(await write(OWNER, current))

    async def test_settings_recheck_role_native_power_membership_and_revision_after_await(self):
        self.enable()
        initial = copy.deepcopy(self.server)
        def revoke_role(): self.server[(fixture.policy_module.POLICY, '')].content['roles'][2]['permissions'].remove('manage_server')
        def revoke_power(): self.server[('m.room.power_levels', '')].content['users']['@admin:local'] = 0
        def revoke_member(): self.server[('m.room.member', '@admin:local')].content['membership'] = 'leave'
        def change_revision(): self.server[(PROFILE_POLICY, '')].event_id = '$new'
        for mutate in (revoke_role, revoke_power, revoke_member, change_revision):
            self.server = copy.deepcopy(initial); self.states[SERVER] = self.server
            previous = copy.deepcopy(self.server)
            async def changed(room, *args):
                mutate()
                return self.states.get(room, {})
            self.module.api.get_room_state = changed
            self.assertFalse(await self.allowed(PROFILE_POLICY, settings(**{'io.tavern.previous_event': '$profile-policy'}), actor='@admin:local', key='', room=SERVER, state=previous), mutate.__name__)

    async def test_roleless_owner_can_configure_and_recover_corrupt_profile_policy(self):
        self.enable()
        del self.server[(fixture.policy_module.POLICY, '')]
        self.server[(PROFILE_POLICY, '')].content = {}
        repaired = settings(enabled=False, **{'io.tavern.previous_event': '$profile-policy'})
        self.assertTrue(await self.allowed(PROFILE_POLICY, repaired, actor=OWNER, key='', room=SERVER, state=self.server))
        self.assertFalse(await self.allowed(PROFILE_POLICY, repaired, actor='@admin:local', key='', room=SERVER, state=self.server))
        self.server[('m.room.create', '')].content['m.federate'] = True
        self.assertFalse(await self.allowed(PROFILE_POLICY, repaired, actor=OWNER, key='', room=SERVER, state=self.server))

    async def test_policy_and_relationship_redactions_cannot_remove_enforcement(self):
        self.enable()
        self.module.api._store.get_event = AsyncMock(return_value=self.server[(PROFILE_POLICY, '')])
        self.assertFalse(await self.allowed('m.room.redaction', {'redacts': '$profile-policy'}, actor=OWNER, key=None))
        del self.server[(fixture.policy_module.POLICY, '')]
        self.assertFalse(await self.allowed('m.space.parent', {}, key=SERVER))
        self.assertTrue(await self.allowed('m.space.parent', {}, key=SERVER, actor=OWNER))
        self.module.api._store.get_event.return_value = self.room[('m.space.parent', SERVER)]
        self.assertFalse(await self.allowed('m.room.redaction', {'redacts': '$parent'}, actor=OWNER, key=None))

    async def test_plain_text_urls_and_opaque_messages_are_not_content_classification(self):
        self.enable(allowLinks=False)
        self.assertTrue(await self.publish(profile(bio='My site is https://example.com/')))
        self.assertTrue(await self.allowed('m.room.encrypted', {'ciphertext': 'opaque', PROFILE: {'unrelated': 'content'}}, key=None))

    async def test_native_rust_mapping_snapshot_and_unavailable_state_behavior(self):
        self.enable()
        for state in (self.server, self.room):
            for item in state.values(): item.content = NativeMapping(item.content)
        self.assertTrue(await self.publish(NativeMapping(profile(links=[NativeMapping({'label': 'A', 'url': 'https://a.test/'})]))))
        self.module.api.get_room_state = AsyncMock(side_effect=RuntimeError('unavailable'))
        item = fixture.event('m.room.member', key=MEMBER, body={'membership': 'join', PROFILE: profile()})
        with self.assertRaises(ProfilePolicyDenied):
            await self.checker.check(item, self.room)
        basic = fixture.event('m.room.member', key=MEMBER, body={'membership': 'join'})
        self.assertTrue(await self.checker.check(basic, self.room))

    async def test_native_callback_exposes_actionable_sanitized_denial(self):
        self.enable(allowLinks=False)
        class NativeError(Exception):
            def __init__(self, status, message, code): self.status, self.message, self.code = status, message, code
        item = fixture.event('m.room.member', key=MEMBER, body={'membership': 'join', PROFILE: profile(links=[{'label': 'A', 'url': 'https://secret.example.test'}])})
        with patch.dict('sys.modules', {'synapse.module_api.errors': SimpleNamespace(SynapseError=NativeError)}):
            with self.assertRaises(NativeError) as rejected: await self.module.check_event_with_errors(item, self.room)
        self.assertEqual(rejected.exception.status, 403)
        self.assertIn('does not allow profile links', rejected.exception.message)
        self.assertNotIn('secret.example.test', rejected.exception.message)

    def test_fixed_settings_schema_and_maximum_extension_size(self):
        self.assertTrue(valid_settings(settings()))
        for field, bad in [('enabled', 1), ('allowLinks', None), ('maxBioLength', 999999), ('maxStatusLength', True), ('version', True), ('io.tavern.previous_event', 'bad')]:
            self.assertFalse(valid_settings(settings(**{field: bad})))
        missing = settings(); del missing['io.tavern.previous_event']
        self.assertFalse(valid_settings(missing))
        self.assertFalse(valid_settings(settings(extra=True)))
        huge = profile(bio='界' * 1000, name='界' * 60, pronouns='界' * 50, timezone='界' * 80, language='界' * 30,
            status='界' * 160, statusEmoji='界' * 16, avatar='mxc://host/' + '界' * 1000, banner='mxc://host/' + '界' * 1000,
            links=[{'label': '界' * 60, 'url': 'https://host/' + '界' * 980}] * 5, fields=[{'label': '界' * 60, 'value': '界' * 300}] * 8)
        self.assertIn('32 KiB', profile_error(huge, ROOM, False))
