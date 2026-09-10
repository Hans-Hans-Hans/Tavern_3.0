import copy
import unittest

from synapse_modules import tavern_policy as model
from synapse_modules.conference_publication import MARKER, PREVIOUS, PUBLICATION, migration
from tests import test_call_audio_policy as audio
from tests import test_roles as roles

OWNER, MOD, TARGET, SERVER, ROOM = audio.OWNER, audio.MOD, audio.TARGET, audio.SERVER, audio.ROOM


class PublicationNativeTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = audio.CallAudioPolicyTests.asyncSetUp

    def saved(self, data=None, eid='$roles'):
        self.server[(model.POLICY, '')] = roles.event(model.POLICY, room=SERVER, key='', sender=OWNER,
            body=data or migration(self.policy), eid=eid)
        return self.server[(model.POLICY, '')].content

    async def write(self, data, actor=OWNER, state=None):
        return await self.module.check_event_allowed(roles.event(model.POLICY, sender=actor, room=SERVER, key='', body=data), state or self.server)

    async def effective(self):
        scopes = await self.module.audio_moderation.scopes(ROOM, self.room)
        return model.effective_publication(scopes, TARGET, model)

    async def test_legacy_implicit_rights_and_atomic_owner_migration_preserve_every_other_field(self):
        current = await self.effective()
        self.assertTrue(all(current[key] for key in PUBLICATION))
        self.policy['unrelated'] = {'preserved': ['yes']}
        proposed = migration(self.policy)
        proposed[PREVIOUS] = '$event'
        self.assertEqual(await self.write(proposed), (True, None))
        self.assertNotIn(MARKER, self.policy)
        for alter in (lambda value: value['roles'][0]['permissions'].remove('speak'),
                      lambda value: value['members'].update({TARGET: ['mod']}),
                      lambda value: value.pop('unrelated')):
            changed = copy.deepcopy(proposed); alter(changed)
            self.assertEqual(await self.write(changed), (False, None))
        self.assertEqual(await self.write(proposed, MOD), (False, None))

    async def test_marked_policy_cas_is_mandatory_monotonic_and_cannot_be_created_without_migration(self):
        saved = self.saved()
        for marker in (None, False, 0, 2, '1'):
            changed = copy.deepcopy(saved)
            if marker is None: changed.pop(MARKER)
            else: changed[MARKER] = marker
            changed[PREVIOUS] = '$roles'
            self.assertEqual(await self.write(changed), (False, None))
        self.assertEqual(await self.write(saved), (False, None))
        self.assertEqual(await self.write({**saved, PREVIOUS: '$stale'}), (False, None))
        self.assertEqual(await self.write({**saved, PREVIOUS: '$roles'}), (True, None))
        del self.server[(model.POLICY, '')]
        self.assertEqual(await self.write({**saved, PREVIOUS: None}), (False, None))

    async def test_stale_unmarked_context_cannot_drop_new_marker_and_fresh_membership_native_power_are_required(self):
        previous = copy.deepcopy(self.server)
        saved = self.saved()
        self.assertEqual(await self.write(self.policy, state=previous), (False, None))
        self.server[('m.room.member', OWNER)].content['membership'] = 'leave'
        self.assertEqual(await self.write({**saved, PREVIOUS: '$roles'}), (False, None))
        self.server[('m.room.member', OWNER)].content['membership'] = 'join'
        self.server[('m.room.create', '')].content['room_version'] = '11'
        self.assertEqual(await self.write({**saved, PREVIOUS: '$roles'}), (False, None))
        self.server[('m.room.power_levels', '')].content['users'][OWNER] = 100
        self.assertEqual(await self.write({**saved, PREVIOUS: '$roles'}), (True, None))

    async def test_category_then_channel_member_override_and_owner_authority(self):
        saved = self.saved()
        saved['categoryOverrides'] = {'voice': {'roles': {'everyone': {'speak': -1}}, 'users': {}}}
        self.server[(model.LAYOUT, '')] = roles.event(model.LAYOUT, body={'version': 1, 'categories': [{'id': 'voice', 'name': 'Voice'}], 'channels': [{'id': ROOM, 'category': 'voice'}]})
        self.assertFalse((await self.effective())['speak'])
        saved['overrides'][ROOM] = {'roles': {}, 'users': {TARGET: {'speak': 1, 'video': -1}}}
        result = await self.effective()
        self.assertTrue(result['speak']); self.assertFalse(result['video'])
        self.assertTrue(model.permissions(model.ResolvedPolicy(saved, self.server[(model.LAYOUT, '')].content), OWNER, ROOM) >= set(PUBLICATION))

    async def test_every_parent_path_intersects_and_own_policy_cannot_hide_stricter_ancestor(self):
        self.saved()
        top = '!top:local'; self.states[top] = audio.state_room(top, space=True, managed=True)
        audio.link(self.states, SERVER, top)
        parent_policy = migration(self.states[top][(model.POLICY, '')].content)
        parent_policy['overrides'][SERVER] = {'roles': {'everyone': {'screen_share': -1}}, 'users': {}}
        self.states[top][(model.POLICY, '')].content = parent_policy
        self.assertFalse((await self.effective())['screen_share'])
        self.states[top][('m.room.member', TARGET)].content['membership'] = 'leave'
        result = await self.effective(); self.assertFalse(result['joined']); self.assertFalse(result['speak'])

    async def test_unmarked_publication_entries_and_invalid_ancestor_policy_fail_closed(self):
        self.policy['roles'][0]['permissions'].append('speak')
        self.assertFalse(model.valid_policy(self.policy))
        with self.assertRaises(ValueError): await self.effective()
        self.policy['roles'][0]['permissions'].remove('speak')
        for marker in (None, True, '1', 2):
            self.policy[MARKER] = marker
            self.assertFalse(model.valid_policy(self.policy))

    async def test_parent_unlink_and_redaction_cannot_shed_publication_without_governing_owner(self):
        self.saved()
        removal = roles.event('m.space.parent', room=ROOM, sender=MOD, key=SERVER, body={})
        self.assertFalse(await self.module.audio_moderation.protect_links(removal, self.room))
        removal.sender = OWNER
        self.assertTrue(await self.module.audio_moderation.protect_links(removal, self.room))
        original = self.room[('m.space.parent', SERVER)]
        async def lookup(*args, **kwargs): return original
        self.module.api._store.get_event = lookup
        result = await self.module.audio_moderation.check(roles.event('m.room.redaction', room=ROOM, sender=OWNER, body={'redacts': original.event_id}), self.room)
        self.assertFalse(result)

    async def test_publication_role_edit_cannot_grant_actor_missing_right(self):
        saved = self.saved()
        saved['roles'][0]['permissions'].remove('speak')
        saved['roles'].append({'id': 'lower', 'name': 'Lower', 'position': 5, 'permissions': []})
        proposed = copy.deepcopy(saved); proposed['roles'][-1]['permissions'] = ['speak']; proposed[PREVIOUS] = '$roles'
        self.assertEqual(await self.write(proposed, MOD), (False, None))
        self.assertEqual(await self.write(proposed), (True, None))
