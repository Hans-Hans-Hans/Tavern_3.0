"""Native Matrix state authorization, independent of any Tavern UI or gateway."""
import copy
import time
import unittest

from tests import test_roles as fixture
from synapse_modules.call_audio_policy import AUDIO, PREVIOUS, effective_audio, valid_audio, audio_state_key, audio_target

OWNER, MOD, TARGET = '@owner:local', '@mod:local', '@member:local'
SERVER, ROOM = '!server:local', '!channel:local'


def state_room(identity, space=False, managed=False):
    state = {
        ('m.room.create', ''): fixture.event('m.room.create', sender=OWNER, key='', room=identity,
            body={'m.federate': False, 'room_version': '12', **({'type': 'm.space'} if space else {})}),
        ('m.room.power_levels', ''): fixture.event('m.room.power_levels', room=identity,
            body={'users': {MOD: 50, '@admin:local': 75}, 'kick': 50, 'state_default': 50}),
    }
    if not space:
        state[('m.room.encryption', '')] = fixture.event('m.room.encryption', room=identity, body={'algorithm': 'm.megolm.v1.aes-sha2'})
    for user in (OWNER, MOD, TARGET, '@admin:local'):
        state[('m.room.member', user)] = fixture.event('m.room.member', key=user, sender=user, room=identity, body={'membership': 'join'})
    if managed:
        policy = fixture.policy()
        policy['roles'][1]['permissions'] += ['mute_members', 'deafen_members']
        state[(fixture.policy_module.POLICY, '')] = fixture.event(fixture.policy_module.POLICY, room=identity, body=policy)
    return state


def link(states, child, parent):
    states[child][('m.space.parent', parent)] = fixture.event('m.space.parent', room=child, key=parent, body={'via': ['local'], 'canonical': True})
    states[parent][('m.space.child', child)] = fixture.event('m.space.child', room=parent, key=child, body={'via': ['local']})


def restriction(muted=False, deafened=False, previous=None):
    return {'version': 1, 'muted': muted, 'deafened': deafened, PREVIOUS: previous}


class CallAudioPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await fixture.EventTests.asyncSetUp(self)
        self.server = state_room(SERVER, space=True, managed=True)
        self.room = state_room(ROOM)
        self.states = {SERVER: self.server, ROOM: self.room}
        link(self.states, ROOM, SERVER)
        self.policy = self.server[(fixture.policy_module.POLICY, '')].content
        self.reads = []

        async def read(identity, event_filter=None):
            self.reads.append(identity)
            return self.states[identity]
        self.module.api.get_room_state = read
        self.module.audio_moderation.enabled = True

    def stored(self, room=ROOM, muted=True, deafened=False, eid='$saved'):
        item = fixture.event(AUDIO, sender=MOD, key=audio_state_key(TARGET), room=room, eid=eid, body=restriction(muted, deafened))
        self.states[room][(AUDIO, audio_state_key(TARGET))] = item
        return item

    async def write(self, *, room=ROOM, actor=MOD, target=TARGET, data=None):
        try:
            key = '_' + target[1:] if isinstance(target, str) and target.startswith('@') else target
            return await self.module.check_event_allowed(fixture.event(AUDIO, sender=actor, key=key, room=room,
                body=restriction(True) if data is None else data), self.states[room])
        except fixture.policy_module.EligibilityDenied:
            # Production check_event_with_errors translates this earlier native
            # eligibility refusal to M_FORBIDDEN. It is not an audio grant.
            return False, None

    async def test_flags_have_independent_permissions_and_preserve_the_other_flag(self):
        self.policy['roles'][1]['permissions'].remove('deafen_members')
        self.assertEqual(await self.write(), (True, None))
        self.assertEqual(await self.write(data=restriction(False, True)), (False, None))
        self.assertEqual(await self.write(data=restriction(True, True)), (False, None))
        self.stored(deafened=True)
        self.assertEqual(await self.write(data=restriction(False, True, '$saved')), (True, None))
        self.assertEqual(await self.write(data=restriction(False, False, '$saved')), (False, None))
        self.policy['roles'][1]['permissions'].append('deafen_members')
        self.assertEqual(await self.write(data=restriction(False, False, '$saved')), (True, None))

    async def test_native_state_key_replaces_reserved_sigil_without_expanding_valid_ids(self):
        for target in (TARGET, '@_member:local', '@' + 'x' * 248 + ':local'):
            key = audio_state_key(target)
            self.assertFalse(key.startswith('@'), 'Stable native room auth reserves @ keys for their own sender')
            self.assertEqual(audio_target(key), target)
            self.assertEqual(len(key.encode()), len(target.encode()))
            self.assertLessEqual(len(key.encode()), 255)
        for invalid in (TARGET, 'user:' + TARGET, '', '_:local', '_bad:local\n'):
            with self.assertRaises(ValueError):
                audio_target(invalid)
        with self.assertRaises(ValueError):
            audio_state_key('@' + '\u00e9' * 125 + ':local')
        for raw_key in (TARGET, 'user:' + TARGET):
            result = await self.module.check_event_allowed(fixture.event(AUDIO, key=raw_key, sender=OWNER,
                body=restriction(True)), self.room)
            self.assertEqual(result, (False, None))
        self.assertEqual(await self.write(), (True, None))

    async def test_revision_is_mandatory_and_stale_owners_cannot_replace_state(self):
        self.stored()
        for previous in (None, '$stale'):
            self.assertEqual(await self.write(actor=OWNER, data=restriction(False, False, previous)), (False, None))
        self.assertEqual(await self.write(actor=OWNER, data=restriction(False, False, '$saved')), (True, None))
        no_revision = restriction(False)
        del no_revision[PREVIOUS]
        self.assertEqual(await self.write(actor=OWNER, data=no_revision), (False, None))
        self.assertEqual(await self.write(data=restriction(True, False, '$saved')), (False, None), 'No-op updates do not churn the durable revision')

    async def test_runtime_default_off_denies_new_restrictions_but_allows_authorized_clear(self):
        self.module.audio_moderation.enabled = False
        self.assertEqual(await self.write(), (False, None))
        self.stored(muted=True, deafened=True)
        self.assertEqual(await self.write(data=restriction(False, True, '$saved')), (True, None))
        self.assertEqual(await self.write(data=restriction(False, False, '$saved')), (True, None))
        self.stored(muted=True, deafened=False)
        self.assertEqual(await self.write(data=restriction(False, True, '$saved')), (False, None))
        self.policy['roles'][1]['permissions'].remove('mute_members')
        self.assertEqual(await self.write(data=restriction(False, False, '$saved')), (False, None))
        self.assertFalse(fixture.policy_module.TavernPolicy.parse_config({})['audio_moderation_enabled'])
        for value in (1, 'true', None, []):
            with self.assertRaises(ValueError):
                fixture.policy_module.TavernPolicy.parse_config({'audio_moderation_enabled': value})

    async def test_inspection_remains_authorized_after_clear_offline_without_authorizing_new_true(self):
        self.module.audio_moderation.enabled = False
        self.stored(muted=False, deafened=False)
        self.room[('m.room.member', TARGET)].content['membership'] = 'leave'
        scopes = await self.module.audio_moderation.scopes(ROOM, self.room)
        inspect = self.module.audio_moderation.permissions_for
        self.assertEqual(inspect(self.room, scopes, MOD, TARGET), {'mute': True, 'deafen': True})
        self.assertEqual(await self.write(data=restriction(True, False, '$saved')), (False, None))
        self.policy['roles'][1]['permissions'].remove('deafen_members')
        self.assertEqual(inspect(self.room, scopes, MOD, TARGET), {'mute': True, 'deafen': False})
        self.assertEqual(inspect(self.room, scopes, MOD, '@unknown:local'), {'mute': False, 'deafen': False})
        self.server[('m.room.member', MOD)].content['membership'] = 'leave'
        self.assertEqual(inspect(self.room, scopes, MOD, TARGET), {'mute': False, 'deafen': False})

    async def test_native_thresholds_and_v12_creator_hierarchy_are_not_granted_by_roles(self):
        powers = self.room[('m.room.power_levels', '')].content
        for key in ('kick', 'state_default'):
            powers[key] = 75
            self.assertEqual(await self.write(), (False, None))
            powers[key] = 50
        powers['events'] = {AUDIO: 75}
        self.assertEqual(await self.write(), (False, None))
        self.assertEqual(await self.write(actor=OWNER), (True, None))
        powers['events'][AUDIO] = True
        self.assertEqual(await self.write(actor=OWNER), (False, None))
        powers['events'][AUDIO] = 50
        powers['users'][TARGET] = 50
        self.assertEqual(await self.write(), (False, None))
        powers['users'][TARGET] = 0
        self.room[('m.room.create', '')].content['additional_creators'] = [TARGET]
        self.assertEqual(await self.write(actor=OWNER), (False, None))
        self.assertEqual(await self.write(target=MOD), (False, None))

    async def test_custom_hierarchy_and_native_child_moderators_remain_distinct(self):
        self.policy['members'][TARGET] = ['mod']
        self.assertEqual(await self.write(), (False, None))
        del self.policy['members'][TARGET]
        # Parent native state power is not an invented extra child-write requirement.
        self.server[('m.room.power_levels', '')].content['users'][MOD] = 0
        self.assertEqual(await self.write(), (True, None))
        self.assertEqual(await self.write(room=SERVER), (False, None))

    async def test_joined_actor_and_current_restrictions_are_checked_in_every_scope(self):
        for current in (self.room, self.server):
            member = current[('m.room.member', MOD)].content
            member['membership'] = 'leave'
            self.assertEqual(await self.write(), (False, None))
            member['membership'] = 'join'
            for kind in ('io.tavern.timeout', 'io.tavern.tempban'):
                current[(kind, MOD)] = fixture.event(kind, body={'version': 1, 'until': int(time.time() * 1000) + 60000})
                self.assertEqual(await self.write(), (False, None))
                current[(kind, MOD)].content['until'] = 'invalid'
                self.assertEqual(await self.write(), (False, None))
                del current[(kind, MOD)]

    async def test_departed_target_can_be_cleared_but_cannot_gain_new_restrictions(self):
        self.room[('m.room.member', TARGET)].content['membership'] = 'leave'
        self.assertEqual(await self.write(), (False, None))
        self.stored(muted=True, deafened=True)
        self.assertEqual(await self.write(data=restriction(False, True, '$saved')), (True, None))
        self.assertEqual(await self.write(data=restriction(False, False, '$saved')), (True, None))
        self.stored(muted=True)
        self.assertEqual(await self.write(data=restriction(True, True, '$saved')), (False, None))

    async def test_server_state_applies_to_existing_future_children_and_clear_does_not_override_it(self):
        self.assertEqual(await self.write(room=SERVER), (True, None))
        self.stored(room=SERVER, muted=True)
        self.stored(room=ROOM, muted=False, deafened=True)
        scopes = await self.module.audio_moderation.scopes(ROOM, self.room)
        combined = effective_audio(scopes, TARGET)
        self.assertTrue(combined['muted'])
        self.assertTrue(combined['deafened'])
        self.assertEqual({item['roomId'] for item in combined['sources']}, {ROOM, SERVER})
        later = '!future:local'
        self.states[later] = state_room(later)
        link(self.states, later, SERVER)
        self.module.audio_moderation.enabled = False
        self.server[('m.room.member', MOD)].content['membership'] = 'leave'
        current = effective_audio(await self.module.audio_moderation.scopes(later, self.states[later]), TARGET)
        self.assertTrue(current['muted'], 'Issuer departure and feature shutdown never lift an accepted restriction')
        self.assertFalse(current['deafened'], 'Mute never implicitly deafens')

    async def test_all_parent_branches_and_own_roles_do_not_hide_ancestor_rules(self):
        ancestor = '!ancestor:local'
        self.states[ancestor] = state_room(ancestor, space=True, managed=True)
        link(self.states, SERVER, ancestor)
        above = self.states[ancestor][(fixture.policy_module.POLICY, '')].content
        above['overrides'][SERVER] = {'users': {MOD: {'mute_members': -1}}}
        self.assertEqual(await self.write(), (False, None))
        self.assertEqual(await self.write(room=SERVER), (False, None), 'Own managed policy does not hide ancestors')
        del above['overrides'][SERVER]
        self.assertEqual(await self.write(), (True, None))
        second = '!other:local'
        self.states[second] = state_room(second, space=True, managed=True)
        link(self.states, ROOM, second)
        self.states[second][(fixture.policy_module.POLICY, '')].content['roles'][1]['permissions'].remove('mute_members')
        self.assertEqual(await self.write(), (False, None))

    async def test_shared_ancestor_checks_each_immediate_child_category_context(self):
        second, ancestor = '!second:local', '!ancestor:local'
        for identity in (second, ancestor):
            self.states[identity] = state_room(identity, space=True, managed=True)
        link(self.states, ROOM, second)
        link(self.states, SERVER, ancestor)
        link(self.states, second, ancestor)
        top = self.states[ancestor]
        policy = top[(fixture.policy_module.POLICY, '')].content
        top[(fixture.policy_module.LAYOUT, '')] = fixture.event(fixture.policy_module.LAYOUT,
            body={'version': 1, 'categories': [{'id': 'restricted'}], 'channels': [{'id': second, 'category': 'restricted'}]})
        policy['categoryOverrides'] = {'restricted': {'roles': {'mod': {'deafen_members': -1}}}}
        self.assertEqual(await self.write(data=restriction(False, True)), (False, None))
        self.assertEqual(await self.write(), (True, None))
        policy['overrides'][second] = {'users': {MOD: {'deafen_members': 1}}}
        self.assertEqual(await self.write(data=restriction(False, True)), (True, None))

    async def test_roleless_ancestors_still_contribute_durable_state_and_membership(self):
        ancestor = '!roleless:local'
        self.states[ancestor] = state_room(ancestor, space=True)
        link(self.states, SERVER, ancestor)
        self.stored(room=ancestor, muted=False, deafened=True)
        self.assertTrue(effective_audio(await self.module.audio_moderation.scopes(ROOM, self.room), TARGET)['deafened'])
        self.assertEqual(await self.write(), (True, None))
        self.states[ancestor][('m.room.member', MOD)].content['membership'] = 'leave'
        self.assertEqual(await self.write(), (False, None))

    async def test_noncanonical_and_one_way_links_cannot_claim_restrictions_or_authority(self):
        self.stored(room=SERVER)
        self.room[('m.space.parent', SERVER)].content['canonical'] = False
        scopes = await self.module.audio_moderation.scopes(ROOM, self.room)
        self.assertFalse(effective_audio(scopes, TARGET)['muted'])
        self.assertEqual(await self.write(), (False, None), 'Unmanaged DMs are outside this server control')
        self.room[('m.space.parent', SERVER)].content['canonical'] = True
        del self.server[('m.space.child', ROOM)]
        self.assertEqual(await self.write(), (False, None))

    async def test_invalid_state_and_scopes_fail_closed_without_silently_unmuting(self):
        values = [restriction(True) | {'reason': 'overbroad'}, restriction(True) | {'version': True},
                  restriction(True) | {'muted': 1}, restriction(True) | {'deafened': None},
                  restriction(True) | {PREVIOUS: 'not-an-event'}, restriction(True) | {PREVIOUS: '$bad\n'}]
        for data in values:
            self.assertFalse(valid_audio(data))
            self.assertEqual(await self.write(actor=OWNER, data=data), (False, None))
        for target in ('@missing-domain', '@bad:local\n', '@' + 'a' * 255 + ':local'):
            self.assertEqual(await self.write(actor=OWNER, target=target), (False, None))
        item = self.stored()
        item.content = {}
        scopes = await self.module.audio_moderation.scopes(ROOM, self.room)
        with self.assertRaises(ValueError):
            effective_audio(scopes, TARGET)
        self.policy['roles'][1]['permissions'].remove('deafen_members')
        self.assertEqual(await self.write(data=restriction(False, False, '$saved')), (False, None))
        self.policy['roles'][1]['permissions'].append('deafen_members')
        self.assertEqual(await self.write(data=restriction(False, False, '$saved')), (True, None))
        self.server[('m.room.create', '')].content['m.federate'] = True
        self.assertEqual(await self.write(), (False, None))

    async def test_private_binding_and_plaintext_channel_cannot_be_used_as_audio_scope(self):
        self.room[('m.room.encryption', '')].content['algorithm'] = 'other'
        self.assertEqual(await self.write(), (False, None))
        self.room[('m.room.encryption', '')].content['algorithm'] = 'm.megolm.v1.aes-sha2'
        self.room[('m.room.create', '')].content['type'] = 'io.tavern.private_thread'
        self.assertFalse(await self.module.audio_moderation.check(fixture.event(AUDIO, key=audio_state_key(TARGET), sender=MOD,
            body=restriction(True)), self.room))
        self.assertEqual(await self.write(), (False, None))

    async def test_malformed_roles_layout_and_reciprocal_routes_do_not_grant_authority(self):
        policy = self.server[(fixture.policy_module.POLICY, '')]
        policy.content = {'version': 1}
        self.assertEqual(await self.write(actor=OWNER), (False, None))
        policy.content = self.policy
        self.server[(fixture.policy_module.LAYOUT, '')] = fixture.event(fixture.policy_module.LAYOUT, body={'version': 1})
        self.assertEqual(await self.write(actor=OWNER), (False, None))
        del self.server[(fixture.policy_module.LAYOUT, '')]
        for via in ('local', ['https://local'], ['local'] * 33):
            self.server[('m.space.child', ROOM)].content['via'] = via
            self.assertEqual(await self.write(actor=OWNER), (False, None))
        self.server[('m.space.child', ROOM)].content['via'] = ['local']
        self.room[('m.space.parent', SERVER)].content['canonical'] = 'true'
        self.assertEqual(await self.write(actor=OWNER), (False, None))

    async def test_stale_parent_authority_membership_layout_and_revision_are_rejected_after_await(self):
        original = self.module.api.get_room_state
        changes = [
            lambda: self.policy['roles'][1]['permissions'].remove('mute_members'),
            lambda: self.server[('m.room.member', MOD)].content.update(membership='leave'),
            lambda: self.server.__setitem__((fixture.policy_module.LAYOUT, ''), fixture.event(fixture.policy_module.LAYOUT,
                body={'version': 1, 'categories': [], 'channels': []}, eid='$new-layout')),
            lambda: self.stored(eid='$concurrent'),
            lambda: self.room[('m.space.parent', SERVER)].content.update(canonical=False),
        ]
        baseline = copy.deepcopy(self.states)
        for change in changes:
            self.states = copy.deepcopy(baseline)
            self.room, self.server = self.states[ROOM], self.states[SERVER]
            self.policy = self.server[(fixture.policy_module.POLICY, '')].content

            async def delayed(identity, event_filter=None):
                if identity == ROOM:
                    change()
                return await original(identity, event_filter)
            self.module.api.get_room_state = delayed
            self.assertEqual(await self.write(), (False, None))

    async def test_bounded_cycles_depth_and_room_count_reject_before_unbounded_reads(self):
        link(self.states, SERVER, ROOM)
        self.assertEqual(await self.write(), (False, None))
        del self.server[('m.space.parent', ROOM)]
        del self.room[('m.space.child', SERVER)]
        last = SERVER
        for index in range(9):
            identity = f'!depth{index}:local'
            self.states[identity] = state_room(identity, space=True)
            link(self.states, last, identity)
            last = identity
        self.assertEqual(await self.write(), (False, None))
        self.assertLess(len(self.reads), 20)
        self.states = {ROOM: state_room(ROOM)}
        self.room = self.states[ROOM]
        self.reads.clear()
        for index in range(33):
            identity = f'!wide{index}:local'
            self.states[identity] = state_room(identity, space=True)
            link(self.states, ROOM, identity)
        self.assertEqual(await self.write(), (False, None))
        self.assertFalse(self.reads, 'Reject excessive direct parent fanout before reading any parent')

    async def test_redaction_cannot_clear_state_even_when_runtime_is_disabled(self):
        self.module.audio_moderation.enabled = False
        original = self.stored()
        async def lookup(*args, **kwargs):
            return original
        self.module.api._store.get_event = lookup
        for actor in (OWNER, MOD, TARGET):
            self.assertEqual(await self.module.check_event_allowed(fixture.event('m.room.redaction', sender=actor,
                body={'redacts': '$saved'}), self.room), (False, None))

    async def test_parent_links_cannot_be_removed_or_redacted_to_shed_roleless_restrictions(self):
        del self.server[(fixture.policy_module.POLICY, '')]
        self.stored(room=SERVER)
        for kind, room, key in (('m.space.parent', ROOM, SERVER), ('m.space.child', SERVER, ROOM)):
            self.assertEqual(await self.module.check_event_allowed(fixture.event(kind, key=key, room=room, sender=MOD), self.states[room]), (False, None))
            self.assertEqual(await self.module.check_event_allowed(fixture.event(kind, key=key, room=room, sender=OWNER), self.states[room]), (True, None))
        original = self.room[('m.space.parent', SERVER)]
        async def lookup(*args, **kwargs):
            return original
        self.module.api._store.get_event = lookup
        self.assertEqual(await self.module.check_event_allowed(fixture.event('m.room.redaction', sender=OWNER,
            body={'redacts': '$event'}), self.room), (False, None))

    async def test_detach_rechecks_copied_native_state_after_ancestor_awaits(self):
        del self.server[(fixture.policy_module.POLICY, '')]
        ancestor = '!roleless-ancestor:local'
        self.states[ancestor] = state_room(ancestor, space=True)
        link(self.states, SERVER, ancestor)
        baseline = copy.deepcopy(self.states)
        for scenario in ('new-parent-restriction', 'owner-departure', 'ancestor-restriction', 'parent-topology'):
            self.states = copy.deepcopy(baseline)
            self.room, self.server = self.states[ROOM], self.states[SERVER]
            actor = MOD if scenario == 'new-parent-restriction' else OWNER
            if scenario == 'owner-departure':
                self.stored(room=SERVER)
            fired = False

            async def read(identity, event_filter=None):
                nonlocal fired
                # Match Synapse's immutable snapshot behavior: changing current
                # state cannot mutate the already returned parent snapshot.
                result = copy.deepcopy(self.states[identity])
                if identity == ancestor and not fired:
                    fired = True
                    if scenario == 'new-parent-restriction':
                        self.stored(room=SERVER)
                    elif scenario == 'owner-departure':
                        self.server[('m.room.member', OWNER)].content['membership'] = 'leave'
                    elif scenario == 'ancestor-restriction':
                        self.stored(room=ancestor)
                    else:
                        self.server[('m.space.parent', ancestor)].content['canonical'] = False
                return result
            self.module.api.get_room_state = read
            proposal = fixture.event('m.space.parent', room=ROOM, key=SERVER, sender=actor, body={})
            with self.subTest(scenario=scenario):
                self.assertEqual(await self.module.check_event_allowed(proposal, copy.deepcopy(self.room)), (False, None))
                self.assertTrue(fired)

    async def test_audio_restrictions_do_not_kick_members_or_claim_to_block_matrix_p2p(self):
        self.stored(room=SERVER, muted=True, deafened=True)
        before = copy.deepcopy(self.room[('m.room.member', TARGET)].content)
        self.assertIsNone(await self.module.audio_moderation.check(fixture.event('m.call.invite', sender=TARGET), self.room))
        self.assertIsNone(await self.module.audio_moderation.check(fixture.event('m.room.encrypted', sender=TARGET), self.room))
        self.assertEqual(self.room[('m.room.member', TARGET)].content, before)


if __name__ == '__main__':
    unittest.main()
