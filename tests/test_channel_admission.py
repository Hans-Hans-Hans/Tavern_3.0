import copy
from types import SimpleNamespace
import unittest

from synapse_modules.channel_admission import (
    AUDIENCES, MARKER, POLICY, CHANGED, DENIED, ChannelAdmissionPolicy, active_audience,
    audience_allows, restricted_rule, valid_admissions,
)

OWNER, ALICE, BOB = ('@' + name + ':test.invalid' for name in ('owner', 'alice', 'bob'))
ROOM, SERVER, SECOND = '!private', '!server', '!second'


def event(data, revision='$one', sender=OWNER):
    return SimpleNamespace(content=data, event_id=revision, sender=sender)


def policy(roles=None, users=None):
    return {'version': 1, 'owner': OWNER, 'roles': [{'id': 'everyone'}, {'id': 'member'}],
            'members': {ALICE: ['member']}, MARKER: 1,
            AUDIENCES: {ROOM: {'roleIds': roles or [], 'userIds': users or []}}}


def server(data):
    return {('m.room.create', ''): event({'type': 'm.space', 'm.federate': False}),
            (POLICY, ''): event(data), ('m.space.child', ROOM): event({'via': ['test.invalid']}),
            **{('m.room.member', user): event({'membership': 'join'}) for user in (OWNER, ALICE, BOB)}}


class AdmissionSchemaTests(unittest.TestCase):
    def test_legacy_and_explicit_empty_are_distinct(self):
        self.assertTrue(valid_admissions({}, {'everyone'}))
        self.assertIsNone(active_audience({}, ROOM))
        value = policy()
        self.assertTrue(valid_admissions(value, {'everyone', 'member'}))
        self.assertFalse(audience_allows(value, ROOM, ALICE))
        self.assertTrue(audience_allows(value, ROOM, OWNER))
        self.assertTrue(audience_allows(value, '!another', ALICE))

    def test_unknown_versions_duplicate_or_unknown_targets_fail_closed(self):
        valid = policy(['member'], [BOB])
        mutations = [
            lambda p: p.update({MARKER: True}), lambda p: p.update({MARKER: 2}),
            lambda p: p.pop(MARKER), lambda p: p.pop(AUDIENCES),
            lambda p: p[AUDIENCES][ROOM].update(roleIds=['missing']),
            lambda p: p[AUDIENCES][ROOM].update(roleIds=['member', 'member']),
            lambda p: p[AUDIENCES][ROOM].update(userIds=[BOB, BOB]),
            lambda p: p[AUDIENCES][ROOM].update(userIds=['@incomplete']),
            lambda p: p[AUDIENCES][ROOM].update(userIds=[['not-a-string']]),
            lambda p: p[AUDIENCES][ROOM].update(extra=True),
            lambda p: p[AUDIENCES].update({'invalid-room': p[AUDIENCES][ROOM]}),
        ]
        for change in mutations:
            with self.subTest(change=change):
                value = copy.deepcopy(valid); change(value)
                self.assertFalse(valid_admissions(value, {'everyone', 'member'}))

    def test_role_and_user_selection_and_everyone(self):
        value = policy(['member'], [BOB])
        self.assertTrue(audience_allows(value, ROOM, ALICE))
        self.assertTrue(audience_allows(value, ROOM, BOB))
        value['members'][ALICE] = []
        self.assertFalse(audience_allows(value, ROOM, ALICE))
        value[AUDIENCES][ROOM]['roleIds'] = ['everyone']
        self.assertTrue(audience_allows(value, ROOM, ALICE))

    def test_native_join_rule_uses_stable_server_ids(self):
        self.assertEqual(restricted_rule([SERVER, SECOND]), {'join_rule': 'restricted', 'allow': [
            {'type': 'm.room_membership', 'room_id': SECOND},
            {'type': 'm.room_membership', 'room_id': SERVER},
        ]})


class AdmissionDecisionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.states = {ROOM: {('m.room.create', ''): event({'m.federate': False}),
                            ('m.space.parent', SERVER): event({'canonical': True, 'via': ['test.invalid']})},
                       SERVER: server(policy(['member']))}
        self.reads = 0
        self.during_read = lambda identity: None
        async def read(identity):
            self.reads += 1
            self.during_read(identity)
            return copy.deepcopy(self.states[identity])
        self.api = SimpleNamespace(get_room_state=read, is_mine=lambda user: user.endswith(':test.invalid'))
        self.admission = ChannelAdmissionPolicy(self.api, lambda p: valid_admissions(p, {'everyone', 'member'}))

    async def test_selected_role_can_join_only_while_in_the_server(self):
        self.assertIsNone(await self.admission.denial(ROOM, self.states[ROOM], ALICE))
        self.states[SERVER]['m.room.member', ALICE] = event({'membership': 'leave'}, '$left')
        self.assertIsNotNone(await self.admission.denial(ROOM, self.states[ROOM], ALICE))

    async def test_all_canonical_parents_must_allow_the_member(self):
        self.states[SECOND] = server(policy(users=[BOB]))
        self.states[ROOM]['m.space.parent', SECOND] = event({'canonical': True, 'via': ['test.invalid']})
        self.assertIsNotNone(await self.admission.denial(ROOM, self.states[ROOM], ALICE))
        self.states[SECOND][POLICY, ''].content[AUDIENCES][ROOM]['userIds'].append(ALICE)
        self.assertIsNone(await self.admission.denial(ROOM, self.states[ROOM], ALICE))

    async def test_one_way_or_noncanonical_parent_does_not_grant_or_restrict(self):
        self.states[SECOND] = server(policy())
        self.states[ROOM]['m.space.parent', SECOND] = event({'canonical': False, 'via': ['test.invalid']})
        self.assertIsNone(await self.admission.denial(ROOM, self.states[ROOM], ALICE))
        self.states[ROOM]['m.space.parent', SECOND].content['canonical'] = True
        del self.states[SECOND]['m.space.child', ROOM]
        self.assertIsNone(await self.admission.denial(ROOM, self.states[ROOM], ALICE))

    async def test_assignment_change_during_state_lookup_rejects_old_admission(self):
        def changed(identity):
            if identity == ROOM:
                self.states[SERVER][POLICY, ''] = event(policy(), '$changed')
        self.during_read = changed
        self.assertIsNotNone(await self.admission.denial(ROOM, self.states[ROOM], ALICE))

    async def test_native_server_owner_binding_and_federation_are_required(self):
        self.states[SERVER]['m.room.create', ''].sender = BOB
        self.assertIsNotNone(await self.admission.denial(ROOM, self.states[ROOM], ALICE))
        self.states[SERVER]['m.room.create', ''].sender = OWNER
        self.states[SERVER]['m.room.create', ''].content['m.federate'] = True
        self.assertIsNotNone(await self.admission.denial(ROOM, self.states[ROOM], ALICE))

    async def test_malformed_opt_in_cannot_fall_back_to_legacy_access(self):
        self.states[SERVER][POLICY, ''].content[MARKER] = True
        self.assertIsNotNone(await self.admission.denial(ROOM, self.states[ROOM], ALICE))

    async def test_regrant_during_a_revocation_check_is_retried_without_a_stale_denial(self):
        self.states[SERVER][POLICY, ''] = event(policy(), '$denied')
        def regrant(identity):
            if identity == ROOM:
                self.states[SERVER][POLICY, ''] = event(policy(['member']), '$regrant')
        self.during_read = regrant
        self.assertEqual(await self.admission.denial(ROOM, self.states[ROOM], ALICE), CHANGED)

    async def test_a_stable_denial_is_distinct_from_unavailable_state(self):
        self.assertEqual(await self.admission.denial(ROOM, self.states[ROOM], BOB), DENIED)
        del self.states[SERVER]
        self.assertNotEqual(await self.admission.denial(ROOM, self.states[ROOM], BOB), DENIED)

    async def test_private_discussion_also_requires_current_membership_of_its_restricted_source(self):
        discussion = '!discussion'
        self.states[discussion] = {('m.room.create', ''): event({
            'type': 'io.tavern.private_thread', 'm.federate': False,
            'io.tavern.private_thread': {'version': 1, 'source_room_id': ROOM, 'source_event_id': ''},
        })}
        self.states[ROOM]['m.room.member', ALICE] = event({'membership': 'join'})
        self.assertIsNone(await self.admission.denial(discussion, self.states[discussion], ALICE))
        self.states[ROOM]['m.room.member', ALICE] = event({'membership': 'leave'}, '$left')
        self.assertEqual(await self.admission.denial(discussion, self.states[discussion], ALICE), DENIED)
        self.assertIsNone(await self.admission.denial(ROOM, self.states[ROOM], ALICE), 'Selected server members can still rejoin the source itself.')

    async def test_native_invited_join_and_invite_both_enforce_the_selected_audience(self):
        self.states[ROOM]['m.room.member', BOB] = event({'membership': 'invite'})
        for membership, sender in [('join', BOB), ('invite', OWNER)]:
            proposed = event({'membership': membership}, sender=sender)
            proposed.type, proposed.room_id, proposed.state_key = 'm.room.member', ROOM, BOB
            self.assertFalse(await self.admission.check(proposed, self.states[ROOM]))

    async def test_a_removed_member_can_leave_but_cannot_send_more_content(self):
        proposed = event({'membership': 'leave'}, sender=BOB)
        proposed.type, proposed.room_id, proposed.state_key = 'm.room.member', ROOM, BOB
        self.assertTrue(await self.admission.check(proposed, self.states[ROOM]))
        proposed.type, proposed.content = 'm.room.encrypted', {'ciphertext': 'opaque'}
        del proposed.state_key
        self.assertFalse(await self.admission.check(proposed, self.states[ROOM]))

    async def test_active_channel_cannot_be_made_public_or_detached(self):
        for kind, identity, state_key, data in [
            ('m.room.join_rules', ROOM, '', {'join_rule': 'public'}),
            ('m.space.parent', ROOM, SERVER, {}),
            ('m.space.child', SERVER, ROOM, {}),
        ]:
            proposed = event(data)
            proposed.type, proposed.room_id, proposed.state_key = kind, identity, state_key
            self.assertFalse(await self.admission.check(proposed, self.states[identity]))


if __name__ == '__main__':
    unittest.main()
