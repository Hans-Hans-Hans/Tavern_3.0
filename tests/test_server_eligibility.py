import copy
from collections.abc import Mapping
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from synapse_modules.server_account_eligibility import ELIGIBILITY, EligibilityDenied, valid_settings, signature, fingerprint
from tests import test_roles as fixture

OWNER, MEMBER, SERVER, ROOM = '@owner:local', '@member:local', '!server:local', '!channel:local'


def config(**changes):
    return {'version': 1, 'requireVerifiedEmail': True, 'minimumAccountAgeSeconds': 0,
            'io.tavern.previous_event': None, **changes}


class EligibilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixture.EventTests.asyncSetUp(self)
        self.server[('m.room.create', '')] = fixture.event('m.room.create', sender=OWNER, body={'type': 'm.space', 'm.federate': False})
        self.room[('m.room.create', '')] = fixture.event('m.room.create', sender=OWNER, body={'m.federate': False})
        for user in (OWNER, MEMBER, '@admin:local'):
            for state in (self.server, self.room):
                state[('m.room.member', user)] = fixture.event('m.room.member', sender=user, key=user, body={'membership': 'join'})
        self.states = {SERVER: self.server, ROOM: self.room}
        async def read(room, *args): return self.states.get(room, {})
        self.module.api.get_room_state = read
        self.native = SimpleNamespace(creation_ts=int(time.time()) - 90000, is_deactivated=False, is_guest=False, locked=False, suspended=False)
        self.module.api.get_userinfo_by_id = AsyncMock(side_effect=lambda _: self.native)
        self.checker = self.module.server_eligibility
        self.checker.account = AsyncMock(return_value={'available': True, 'emailVerified': False})

    def enable(self, **changes):
        self.server[(ELIGIBILITY, '')] = fixture.event(ELIGIBILITY, key='', body=config(**changes), eid='$eligibility')

    async def allowed(self, kind='m.room.encrypted', body=None, actor=MEMBER, key=None, state=None, room=ROOM):
        try:
            return (await self.module.check_event_allowed(fixture.event(kind, body=body, sender=actor, key=key, room=room), self.room if state is None else state))[0]
        except EligibilityDenied:
            return False

    async def test_native_callback_returns_actionable_reason_without_account_fields(self):
        self.enable()
        class NativeError(Exception):
            def __init__(self, status, message, code): self.status, self.message, self.code = status, message, code
        with patch.dict('sys.modules', {'synapse.module_api.errors': SimpleNamespace(SynapseError=NativeError)}):
            with self.assertRaises(NativeError) as denied:
                await self.module.check_event_with_errors(fixture.event('m.room.encrypted'), self.room)
        self.assertEqual(denied.exception.status, 403)
        self.assertEqual(denied.exception.code, 'M_FORBIDDEN')
        self.assertIn('Verify your email', denied.exception.message)
        self.assertNotIn(MEMBER, denied.exception.message)
        self.enable(requireVerifiedEmail=False, minimumAccountAgeSeconds=604800)
        self.assertIn('7 days', await self.checker.denial(ROOM, self.room, MEMBER))
        self.enable()
        self.checker.account.return_value = None
        self.assertIn('temporarily unavailable', await self.checker.denial(ROOM, self.room, MEMBER))

    async def test_missing_and_explicit_off_preserve_existing_accounts_without_bridge(self):
        self.assertTrue(await self.allowed())
        self.enable(requireVerifiedEmail=False)
        self.assertTrue(await self.allowed())
        self.checker.account.assert_not_awaited()
        self.module.api.get_userinfo_by_id.assert_not_awaited()

    async def test_native_join_and_encrypted_writes_use_current_verified_record(self):
        self.enable()
        self.assertFalse(await self.allowed())
        self.assertFalse(await self.allowed('m.room.member', {'membership': 'join'}, key=MEMBER))
        self.checker.account.return_value = {'available': True, 'emailVerified': True}
        self.assertTrue(await self.allowed())
        self.assertTrue(await self.allowed('m.room.member', {'membership': 'join'}, key=MEMBER))
        self.checker.account.return_value = {'available': True, 'emailVerified': False}
        self.assertFalse(await self.allowed(body={'emailVerified': True, 'creation_ts': 1, 'ciphertext': 'opaque'}))

    async def test_age_uses_native_seconds_with_exact_boundary_and_no_client_override(self):
        self.enable(requireVerifiedEmail=False, minimumAccountAgeSeconds=3600)
        self.native.creation_ts = int(time.time()) - 3599
        self.assertFalse(await self.allowed(body={'accountAgeSeconds': 99999999}))
        self.native.creation_ts -= 1
        self.assertTrue(await self.allowed())
        for bad in (True, '1', None, 0, int(time.time()) * 1000):
            self.native.creation_ts = bad
            self.assertFalse(await self.allowed(), repr(bad))

    async def test_unavailable_remote_guest_locked_and_deactivated_fail_closed(self):
        self.enable()
        self.checker.account.return_value = {'available': True, 'emailVerified': True}
        for field in ('is_deactivated', 'is_guest', 'locked', 'suspended'):
            setattr(self.native, field, True)
            self.assertFalse(await self.allowed(), field)
            setattr(self.native, field, False)
        self.checker.account.return_value = {'available': False, 'emailVerified': True}
        self.assertFalse(await self.allowed())
        self.checker.account.return_value = None
        self.assertFalse(await self.allowed())
        self.module.api.is_mine = lambda _: False
        self.assertFalse(await self.allowed())

    async def test_native_userinfo_uses_pinned_is_deactivated_field_not_admin_json_shape(self):
        self.enable()
        self.checker.account.return_value = {'available': True, 'emailVerified': True}
        # Synapse1.160.0 get_userinfo_by_id returns UserInfo.is_deactivated;
        # only the HTTP AdminAPI spells its JSON property "deactivated".
        self.assertFalse(hasattr(self.native, 'deactivated'))
        self.assertTrue(await self.allowed())
        self.native.is_deactivated = True
        self.assertFalse(await self.allowed())
        del self.native.is_deactivated
        self.native.deactivated = False
        self.assertFalse(await self.allowed(), 'An unknown native object shape must fail closed.')

    async def test_all_reciprocal_canonical_parents_apply_even_without_roles(self):
        self.enable(requireVerifiedEmail=False)
        second = copy.deepcopy(self.server)
        del second[(fixture.policy_module.POLICY, '')]
        second[(ELIGIBILITY, '')] = fixture.event(ELIGIBILITY, body=config())
        self.states['!other:local'] = second
        self.room[('m.space.parent', '!other:local')] = fixture.event('m.space.parent', body={'via': ['local'], 'canonical': True})
        self.assertFalse(await self.allowed())
        second[('m.space.child', ROOM)].content = {}
        self.assertTrue(await self.allowed(), 'A nonreciprocal claim cannot impose another server policy')
        second[('m.space.child', ROOM)].content = {'via': ['local']}
        self.room[('m.space.parent', '!other:local')].content = {'via': ['local'], 'canonical': False}
        self.assertTrue(await self.allowed())

    async def test_policy_change_while_account_check_waits_is_not_old_authorization(self):
        self.enable()
        async def changed(_):
            self.enable(minimumAccountAgeSeconds=604800)
            return {'available': True, 'emailVerified': True}
        self.checker.account.side_effect = changed
        self.assertFalse(await self.allowed())

    async def test_own_space_stricter_policy_after_account_await_rejects_previous_event_context(self):
        self.enable()
        previous = copy.deepcopy(self.server)
        async def changed(_):
            self.enable(minimumAccountAgeSeconds=604800)
            return {'available': True, 'emailVerified': True}
        self.checker.account.side_effect = changed
        self.assertFalse(await self.allowed(state=previous, room=SERVER))

    async def test_new_parent_after_account_await_rejects_previous_room_context(self):
        self.enable()
        previous = copy.deepcopy(self.room)
        second = copy.deepcopy(self.server)
        second[(ELIGIBILITY, '')] = fixture.event(ELIGIBILITY, body=config(minimumAccountAgeSeconds=604800), eid='$other')
        self.states['!other:local'] = second
        async def changed(_):
            self.room[('m.space.parent', '!other:local')] = fixture.event('m.space.parent', body={'canonical': True, 'via': ['local']})
            return {'available': True, 'emailVerified': True}
        self.checker.account.side_effect = changed
        self.assertFalse(await self.allowed(state=previous))

    async def test_private_room_source_binding_change_during_account_check_is_rejected(self):
        self.enable()
        private = {('m.room.create', ''): fixture.event('m.room.create', body={'type': 'io.tavern.private_thread', 'm.federate': False,
            'io.tavern.private_thread': {'version': 1, 'source_room_id': ROOM, 'source_event_id': ''}})}
        self.states['!private:local'] = copy.deepcopy(private)
        async def changed(_):
            self.states['!private:local'][('m.room.create', '')].content['io.tavern.private_thread']['source_event_id'] = '$different'
            return {'available': True, 'emailVerified': True}
        self.checker.account.side_effect = changed
        self.assertFalse(await self.checker.eligible('!private:local', private, MEMBER))

    async def test_native_deactivation_during_account_check_is_rechecked(self):
        self.enable()
        async def changed(_):
            self.native.is_deactivated = True
            return {'available': True, 'emailVerified': True}
        self.checker.account.side_effect = changed
        self.assertFalse(await self.allowed())

    async def test_native_suspension_during_account_check_is_rechecked(self):
        self.enable()
        async def changed(_):
            self.native.suspended = True
            return {'available': True, 'emailVerified': True}
        self.checker.account.side_effect = changed
        self.assertFalse(await self.allowed())
        self.assertTrue(await self.allowed('m.room.member', {'membership': 'leave'}, key=MEMBER))

    async def test_owner_can_recover_but_other_administrators_cannot_bypass(self):
        self.enable()
        self.assertTrue(await self.allowed(actor=OWNER))
        self.assertFalse(await self.allowed(actor='@admin:local'))
        self.assertTrue(await self.allowed(ELIGIBILITY, config(requireVerifiedEmail=False, **{'io.tavern.previous_event': '$eligibility'}), actor=OWNER, key='', state=self.server, room=SERVER))
        self.checker.account.assert_awaited()

    async def test_configuration_requires_schema_cas_native_and_custom_authority(self):
        self.assertTrue(await self.allowed(ELIGIBILITY, config(), actor=OWNER, key='', state=self.server, room=SERVER))
        self.enable()
        self.assertFalse(await self.allowed(ELIGIBILITY, config(), actor=OWNER, key='', state=self.server, room=SERVER))
        proposed = config(**{'io.tavern.previous_event': '$eligibility'})
        self.assertTrue(await self.allowed(ELIGIBILITY, proposed, actor=OWNER, key='', state=self.server, room=SERVER))
        self.assertFalse(await self.allowed(ELIGIBILITY, proposed, actor=OWNER, key='other', state=self.server, room=SERVER))
        self.checker.account.return_value = {'available': True, 'emailVerified': True}
        self.server[('m.room.power_levels', '')] = fixture.event('m.room.power_levels', body={'users': {OWNER: 100, MEMBER: 100, '@admin:local': 50}, 'state_default': 50})
        self.assertFalse(await self.allowed(ELIGIBILITY, proposed, actor=MEMBER, key='', state=self.server, room=SERVER))
        self.assertTrue(await self.allowed(ELIGIBILITY, proposed, actor='@admin:local', key='', state=self.server, room=SERVER))
        self.server[('m.room.power_levels', '')].content['users']['@admin:local'] = 0
        self.assertFalse(await self.allowed(ELIGIBILITY, proposed, actor='@admin:local', key='', state=self.server, room=SERVER))

    async def test_settings_authority_is_rechecked_after_verification_await(self):
        self.enable()
        self.server[('m.room.power_levels', '')] = fixture.event('m.room.power_levels', body={'users': {OWNER: 100, '@admin:local': 100}, 'state_default': 50})
        original = copy.deepcopy(self.server)
        def revoke_role():
            self.server[(fixture.policy_module.POLICY, '')].content['roles'][2]['permissions'].remove('manage_server')
        def revoke_native():
            self.server[('m.room.power_levels', '')].content['users']['@admin:local'] = 0
        def revoke_membership():
            self.server[('m.room.member', '@admin:local')].content['membership'] = 'leave'
        for revoke in (revoke_role, revoke_native, revoke_membership):
            self.server = copy.deepcopy(original); self.states[SERVER] = self.server
            previous = copy.deepcopy(self.server)
            async def changed(_):
                revoke()
                return {'available': True, 'emailVerified': True}
            self.checker.account.side_effect = changed
            self.assertFalse(await self.allowed(ELIGIBILITY, config(minimumAccountAgeSeconds=300, **{'io.tavern.previous_event': '$eligibility'}),
                actor='@admin:local', key='', state=previous, room=SERVER), revoke.__name__)

    async def test_config_only_local_space_and_roleless_owner(self):
        self.assertFalse(await self.allowed(ELIGIBILITY, config(), actor=OWNER, key=''))
        del self.server[(fixture.policy_module.POLICY, '')]
        self.assertTrue(await self.allowed(ELIGIBILITY, config(), actor=OWNER, key='', state=self.server, room=SERVER))
        self.server[('m.room.create', '')].content['m.federate'] = True
        self.assertFalse(await self.allowed(ELIGIBILITY, config(), actor=OWNER, key='', state=self.server, room=SERVER))

    async def test_leave_and_owned_call_teardown_remain_possible_without_authority_service(self):
        self.enable()
        self.checker.account.side_effect = RuntimeError('unavailable')
        self.assertTrue(await self.allowed('m.room.member', {'membership': 'leave'}, key=MEMBER))
        for kind in ('m.call.hangup', 'm.call.reject'):
            self.assertTrue(await self.allowed(kind, {'call_id': 'known'}))
        for kind in ('org.matrix.msc3401.call.member', 'org.matrix.msc4143.rtc.member'):
            self.room[(kind, MEMBER)] = fixture.event(kind, key=MEMBER, sender=MEMBER, body={'application': 'm.call'})
            self.assertTrue(await self.allowed(kind, {}, key=MEMBER))
            self.assertFalse(await self.allowed(kind, {'memberships': [], 'application': 'm.call'}, key=MEMBER))
            self.assertFalse(await self.allowed(kind, {}, key=OWNER))

    async def test_reaction_call_and_private_source_cannot_bypass(self):
        self.enable()
        for kind in ('m.reaction', 'm.call.invite', 'org.matrix.msc3401.call.member', 'org.matrix.msc4143.rtc.member'):
            self.assertFalse(await self.allowed(kind, {'application': 'm.call'}))
        private = {('m.room.create', ''): fixture.event('m.room.create', body={'type': 'io.tavern.private_thread', 'm.federate': False,
            'io.tavern.private_thread': {'version': 1, 'source_room_id': ROOM, 'source_event_id': ''}})}
        self.states['!private:local'] = private
        self.assertFalse(await self.checker.eligible('!private:local', private, MEMBER))
        self.checker.account.return_value = {'available': True, 'emailVerified': True}
        self.assertTrue(await self.checker.eligible('!private:local', private, MEMBER))

    async def test_redaction_and_roleless_parent_removal_cannot_strip_enforcement(self):
        self.enable()
        original = self.server[(ELIGIBILITY, '')]
        self.module.api._store.get_event = AsyncMock(return_value=original)
        self.assertFalse(await self.allowed('m.room.redaction', {'redacts': '$eligibility'}, actor=OWNER))
        del self.server[(fixture.policy_module.POLICY, '')]
        self.checker.account.return_value = {'available': True, 'emailVerified': True}
        self.assertFalse(await self.allowed('m.space.parent', {}, key=SERVER))
        self.assertTrue(await self.allowed('m.space.parent', {}, key=SERVER, actor=OWNER))
        self.module.api._store.get_event.return_value = self.room[('m.space.parent', SERVER)]
        self.assertFalse(await self.allowed('m.room.redaction', {'redacts': '$parent'}, actor=OWNER))

    async def test_malformed_existing_policy_and_unavailable_parent_fail_closed(self):
        self.enable()
        self.server[(ELIGIBILITY, '')].content = {}
        self.assertFalse(await self.allowed())
        self.assertTrue(await self.allowed(actor=OWNER), 'The native creator can repair corrupted state')
        self.module.api.get_room_state = AsyncMock(side_effect=RuntimeError('missing state'))
        self.assertFalse(await self.checker.eligible(ROOM, self.room, MEMBER))

    async def test_invited_target_must_also_meet_requirements(self):
        self.enable()
        self.assertFalse(await self.allowed('m.room.member', {'membership': 'invite'}, actor=OWNER, key=MEMBER))
        self.checker.account.return_value = {'available': True, 'emailVerified': True}
        self.assertTrue(await self.allowed('m.room.member', {'membership': 'invite'}, actor=OWNER, key=MEMBER))

    async def test_new_canonical_relationship_cannot_attach_ineligible_actor(self):
        self.enable()
        state = dict(self.room); del state[('m.space.parent', SERVER)]
        proposed = fixture.event('m.space.parent', key=SERVER, body={'via': ['local'], 'canonical': True})
        self.assertFalse(await self.checker.eligible(ROOM, state, MEMBER, proposed))
        self.checker.account.return_value = {'available': True, 'emailVerified': True}
        self.assertTrue(await self.checker.eligible(ROOM, state, MEMBER, proposed))

    async def test_private_create_callback_checks_source_before_creating_partial_room(self):
        self.enable()
        self.module.private_threads.create = AsyncMock(return_value=None)
        request = {'creation_content': {'type': 'io.tavern.private_thread', 'm.federate': False,
            'io.tavern.private_thread': {'version': 1, 'source_room_id': ROOM, 'source_event_id': ''}}, 'invite': []}
        class NativeError(Exception):
            pass
        with patch.dict('sys.modules', {'synapse.module_api.errors': SimpleNamespace(SynapseError=NativeError)}):
            with self.assertRaises(NativeError):
                await self.module.on_create_room(SimpleNamespace(user=SimpleNamespace(to_string=lambda: MEMBER)), request, False)
        self.checker.account.return_value = {'available': True, 'emailVerified': True}
        await self.module.on_create_room(SimpleNamespace(user=SimpleNamespace(to_string=lambda: MEMBER)), request, False)

    def test_strict_schema_rejects_claims_unbounded_ages_and_missing_revision(self):
        self.assertTrue(valid_settings(config()))
        for field, bad in [('version', True), ('requireVerifiedEmail', 1), ('minimumAccountAgeSeconds', True), ('minimumAccountAgeSeconds', 99999999), ('io.tavern.previous_event', 'wrong')]:
            self.assertFalse(valid_settings(config(**{field: bad})))
        missing = config(); del missing['io.tavern.previous_event']
        self.assertFalse(valid_settings(missing))
        self.assertFalse(valid_settings(config(emailVerified=True)))

    def test_native_mapping_fingerprint_detaches_nested_json_without_copy_or_pickle(self):
        class NativeMapping(Mapping):
            def __init__(self, data): self.data = data
            def __getitem__(self, key): return self.data[key]
            def __iter__(self): return iter(self.data)
            def __len__(self): return len(self.data)
            def __deepcopy__(self, memo): raise TypeError('Native mapping cannot be copied')
            def __reduce_ex__(self, protocol): raise TypeError('Native mapping cannot be pickled')
        nested = {'labels': [NativeMapping({'name': 'Before'})]}
        creation = NativeMapping({'type': 'm.space', 'm.federate': False, 'metadata': NativeMapping(nested)})
        settings = config()
        via = ['local']
        current = {
            (ELIGIBILITY, ''): SimpleNamespace(content=NativeMapping(settings), event_id='$policy'),
            ('m.room.create', ''): SimpleNamespace(content=creation, sender=OWNER),
            ('m.space.child', ROOM): SimpleNamespace(content=NativeMapping({'via': via})),
        }
        before = fingerprint([(SERVER, current)], ROOM)
        self.assertEqual(before[SERVER][3]['metadata'], {'labels': [{'name': 'Before'}]})
        settings['requireVerifiedEmail'] = False
        nested['labels'][0].data['name'] = 'After'
        via.append('another')
        self.assertTrue(before[SERVER][2]['requireVerifiedEmail'])
        self.assertEqual(before[SERVER][3]['metadata'], {'labels': [{'name': 'Before'}]})
        self.assertEqual(before[SERVER][4], {'via': ['local']})
        self.assertNotEqual(before, fingerprint([(SERVER, current)], ROOM))


class EligibilityBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_bridge_is_scoped_signed_and_rejects_ambiguous_or_unavailable_results(self):
        with tempfile.TemporaryDirectory() as folder:
            key = bytes(range(32)); path = Path(folder) / 'privacy.key'; path.write_text(key.hex())
            api = SimpleNamespace(http_client=SimpleNamespace(get_json=AsyncMock(return_value={'available': True, 'emailVerified': True})))
            checker = fixture.policy_module.ServerEligibilityPolicy({'privacy_api_url': 'http://private-api:8090', 'privacy_key_file': str(path)}, api, fixture.policy_module)
            self.assertEqual(await checker.account(MEMBER), {'available': True, 'emailVerified': True})
            args, kwargs = api.http_client.get_json.call_args
            self.assertEqual(args[0], 'http://private-api:8090/api/internal/server-eligibility')
            self.assertEqual(kwargs['args'], {'user': MEMBER})
            timestamp = kwargs['headers'][b'X-Tavern-Privacy-Timestamp'][0].decode()
            self.assertEqual(kwargs['headers'][b'X-Tavern-Privacy-Signature'][0].decode(), signature(key, timestamp, MEMBER))
            for result in ({'available': 1, 'emailVerified': True}, {'available': True}, '<html>ok</html>', []):
                api.http_client.get_json.return_value = result
                self.assertIsNone(await checker.account(MEMBER))
            api.http_client.get_json.side_effect = TimeoutError('unavailable')
            self.assertIsNone(await checker.account(MEMBER))
