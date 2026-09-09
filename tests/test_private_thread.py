import copy
import sqlite3
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from synapse_modules.private_thread import PRIVATE, SETTINGS, binding
from synapse_modules.tavern_policy import TavernPolicy, POLICY, LAYOUT

SOURCE, SERVER, ROOM = '!source:test', '!server:test', '!private:test'
AUTHOR, MEMBER, OTHER, OWNER = '@author:test', '@member:test', '@other:test', '@owner:test'


def event(kind, content=None, key=None, sender=AUTHOR, room=ROOM, identity='$event'):
    result = SimpleNamespace(type=kind, content=content or {}, state_key=key, sender=sender, room_id=room, event_id=identity)
    result.get_dict = lambda: {'type': kind, 'content': dict(result.content), 'state_key': key, 'sender': sender, 'room_id': room}
    return result


def settings(**changes):
    return {'version': 1, 'title': 'Private help', 'archived': False, 'autoArchiveSeconds': 0, 'io.tavern.previous_event': None, **changes}


def creation():
    return {'type': PRIVATE, 'm.federate': False, PRIVATE: {'version': 1, 'source_room_id': SOURCE, 'source_event_id': '$opaque/root?#'}}


class PrivateDiscussionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = sqlite3.connect(':memory:')
        async def interaction(_name, callback):
            cursor = self.db.cursor()
            try:
                result = callback(cursor)
                self.db.commit()
                return result
            finally:
                cursor.close()
        self.policy = {'version': 1, 'owner': OWNER, 'roles': [{'id': 'everyone', 'name': 'Member', 'position': 0, 'permissions': ['send_messages', 'create_private_threads', 'invite']}, {'id': 'mod', 'name': 'Moderator', 'position': 50, 'permissions': ['manage_messages', 'kick', 'ban']}], 'members': {AUTHOR: ['mod']}, 'overrides': {}, 'categoryOverrides': {}}
        self.source = {('m.room.create', ''): event('m.room.create', {'m.federate': False}), ('m.room.encryption', ''): event('m.room.encryption', {'algorithm': 'm.megolm.v1.aes-sha2'}), ('m.space.parent', SERVER): event('m.space.parent', {'canonical': True, 'via': ['test']}, SERVER), ('m.room.power_levels', ''): event('m.room.power_levels', {'users': {AUTHOR: 50, OWNER: 100}, 'invite': 0})}
        self.server = {('m.room.create', ''): event('m.room.create', {'type': 'm.space', 'm.federate': False}, sender=OWNER), (POLICY, ''): event(POLICY, self.policy), ('m.space.child', SOURCE): event('m.space.child', {'via': ['test']}, SOURCE), ('m.room.power_levels', ''): event('m.room.power_levels', {'users': {AUTHOR: 50, OWNER: 100}})}
        self.private = {('m.room.create', ''): event('m.room.create', creation()), ('m.room.power_levels', ''): event('m.room.power_levels', {'users': {AUTHOR: 100}, 'events': {SETTINGS: 50}, 'invite': 0}), ('m.room.encryption', ''): event('m.room.encryption', {'algorithm': 'm.megolm.v1.aes-sha2'}), ('m.room.history_visibility', ''): event('m.room.history_visibility', {'history_visibility': 'joined'}), ('m.room.join_rules', ''): event('m.room.join_rules', {'join_rule': 'invite'}), (SETTINGS, ''): event(SETTINGS, settings(), '', identity='$settings')}
        for user in (AUTHOR, MEMBER, OTHER, OWNER):
            for state in (self.source, self.server):
                state[('m.room.member', user)] = event('m.room.member', {'membership': 'join'}, user)
        for user in (AUTHOR, MEMBER):
            self.private[('m.room.member', user)] = event('m.room.member', {'membership': 'join'}, user)
        self.states = {SOURCE: self.source, SERVER: self.server, ROOM: self.private}
        self.events = {'$opaque/root?#': event('m.room.encrypted', room=SOURCE), '$settings': self.private[(SETTINGS, '')]}
        async def state(room, event_filter=None): return self.states.get(room, {})
        async def lookup(identity, allow_none=False): return self.events.get(identity)
        async def privacy(user, kind): return self.accounts.get((user, kind), {})
        self.accounts, self.callbacks = {}, {}
        self.api = SimpleNamespace(get_room_state=state, register_third_party_rules_callbacks=lambda **callbacks: self.callbacks.update(callbacks), is_mine=lambda user: user.endswith(':test'), _store=SimpleNamespace(get_event=lookup, db_pool=SimpleNamespace(runInteraction=interaction)), account_data_manager=SimpleNamespace(get_global=privacy))
        self.module = TavernPolicy({}, self.api)

    async def asyncTearDown(self):
        self.db.close()

    def request(self):
        return {'creation_content': creation(), 'visibility': 'private', 'invite': [MEMBER], 'initial_state': [{'type': SETTINGS, 'state_key': '', 'content': settings()}]}

    async def allowed(self, item, state=None):
        return (await self.module.check_event_allowed(item, self.private if state is None else state))[0]

    async def test_creation_normalizes_native_privacy_without_parent_index_or_plaintext_copy(self):
        request = self.request()
        request['power_level_content_override'] = {'users_default': 100, 'invite': -100}
        self.assertIsNone(await self.module.private_threads.create(AUTHOR, request))
        initial = {item['type']: item['content'] for item in request['initial_state']}
        self.assertEqual(initial['m.room.history_visibility'], {'history_visibility': 'joined'})
        self.assertEqual(initial['m.room.join_rules'], {'join_rule': 'invite'})
        self.assertEqual(initial['m.room.guest_access'], {'guest_access': 'forbidden'})
        self.assertEqual(initial['m.room.encryption']['algorithm'], 'm.megolm.v1.aes-sha2')
        self.assertNotIn('m.space.parent', initial)
        self.assertEqual(request['power_level_content_override']['users_default'], 0)
        self.assertNotIn('m.room.message', initial)
        self.assertEqual(binding(request['creation_content'])['source_event_id'], '$opaque/root?#')
        self.assertIn('on_create_room', self.callbacks)

    async def test_creation_rejects_unsafe_source_shape_plaintext_public_remote_and_foreign_message(self):
        mutations = [lambda r: r.update(visibility='public'), lambda r: r.update(room_alias_name='published'), lambda r: r.update(invite_3pid=[{}]), lambda r: r.update(invite=[MEMBER, MEMBER]), lambda r: r['creation_content'].update({'m.federate': True}), lambda r: r['initial_state'].append({'type': 'm.space.parent', 'state_key': SERVER, 'content': {'via': ['test']}}), lambda r: r['creation_content'][PRIVATE].update(source_event_id='$foreign')]
        self.events['$foreign'] = event('m.room.encrypted', room='!foreign:test')
        for mutate in mutations:
            request = self.request(); mutate(request)
            self.assertIsNotNone(await self.module.private_threads.create(AUTHOR, request))
        self.source[('m.room.encryption', '')].content = {}
        self.assertIsNotNone(await self.module.private_threads.create(AUTHOR, self.request()))

    async def test_creation_current_native_custom_and_all_parent_membership_requirements(self):
        self.source[('m.room.power_levels', '')].content['events'] = {'m.room.encrypted': 100}
        self.assertIsNotNone(await self.module.private_threads.create(AUTHOR, self.request()))
        self.source[('m.room.power_levels', '')].content.pop('events')
        self.policy['overrides'][SOURCE] = {'users': {AUTHOR: {'create_private_threads': -1}}}
        self.assertIsNotNone(await self.module.private_threads.create(AUTHOR, self.request()))
        self.policy['overrides'] = {}
        self.server[('m.room.member', MEMBER)].content['membership'] = 'leave'
        self.assertIsNotNone(await self.module.private_threads.create(AUTHOR, self.request()))
        self.server[('m.room.member', MEMBER)].content['membership'] = 'join'
        self.source[('m.space.parent', '!missing:test')] = event('m.space.parent', {'canonical': True, 'via': ['test']}, '!missing:test')
        self.assertIsNotNone(await self.module.private_threads.create(AUTHOR, self.request()))

    async def test_direct_join_requires_private_invitation_even_for_source_owner(self):
        for user in (OTHER, OWNER):
            self.assertFalse(await self.allowed(event('m.room.member', {'membership': 'join'}, user, user)))
        self.private[('m.room.member', OTHER)] = event('m.room.member', {'membership': 'invite'}, OTHER)
        self.assertTrue(await self.allowed(event('m.room.member', {'membership': 'join'}, OTHER, OTHER)))
        self.source[('m.room.member', OTHER)].content['membership'] = 'leave'
        self.assertFalse(await self.allowed(event('m.room.member', {'membership': 'join'}, OTHER, OTHER)))

    async def test_invites_recheck_source_membership_native_permissions_privacy_and_target_restrictions(self):
        invite = event('m.room.member', {'membership': 'invite'}, OTHER)
        self.assertTrue(await self.allowed(invite))
        self.accounts[(OTHER, 'm.ignored_user_list')] = {'ignored_users': {AUTHOR: {}}}
        self.assertFalse(await self.allowed(invite))
        self.accounts.clear()
        self.source[('m.room.power_levels', '')].content['invite'] = 100
        self.assertFalse(await self.allowed(invite))
        self.source[('m.room.power_levels', '')].content['invite'] = 0
        self.server[('io.tavern.timeout', OTHER)] = event('io.tavern.timeout', {'until': 9999999999999}, OTHER)
        self.assertFalse(await self.allowed(invite))

    async def test_private_configuration_cannot_be_widened_redacted_or_published(self):
        for kind, data in [('m.room.history_visibility', {'history_visibility': 'shared'}), ('m.room.encryption', {}), ('m.room.join_rules', {'join_rule': 'public'}), ('m.room.guest_access', {'guest_access': 'can_join'}), ('m.room.power_levels', {'users_default': 100}), ('m.space.parent', {'canonical': True, 'via': ['test']}), ('m.room.tombstone', {'replacement_room': '!public:test'})]:
            self.assertFalse(await self.allowed(event(kind, data, '')))
        for kind in ('m.room.create', 'm.room.encryption', 'm.room.history_visibility', SETTINGS):
            self.events['$protected'] = event(kind)
            self.assertFalse(await self.allowed(event('m.room.redaction', {'redacts': '$protected'})))
        self.assertFalse(await self.module.private_threads.visibility(ROOM, self.private, 'public'))
        self.assertTrue(await self.module.private_threads.visibility(ROOM, self.private, 'private'))
        self.assertFalse(await self.module.private_threads.threepid('email', 'test@example.org', self.private))
        self.assertFalse(await self.allowed(event('m.space.child', {'via': ['test']}, ROOM, room=SERVER), self.server))

    async def test_private_writes_recheck_categories_canonical_reciprocals_native_and_restrictions(self):
        message = event('m.room.encrypted', {'ciphertext': 'opaque'}, sender=MEMBER)
        self.assertTrue(await self.allowed(message))
        self.server[(LAYOUT, '')] = event(LAYOUT, {'version': 1, 'categories': [{'id': 'quiet'}], 'channels': [{'id': SOURCE, 'category': 'quiet'}]})
        self.policy['categoryOverrides'] = {'quiet': {'users': {MEMBER: {'send_messages': -1}}}}
        self.assertFalse(await self.allowed(message))
        self.policy['categoryOverrides'] = {}
        self.private[('m.room.power_levels', '')].content['events']['m.room.encrypted'] = 50
        self.assertFalse(await self.allowed(message))
        self.private[('m.room.power_levels', '')].content['events'].pop('m.room.encrypted')
        self.server[('m.space.child', SOURCE)].content = {}
        self.assertFalse(await self.allowed(message))
        self.server[('m.space.child', SOURCE)].content = {'via': ['test']}
        self.server[('io.tavern.tempban', MEMBER)] = event('io.tavern.tempban', {'version': 1, 'until': 9999999999999}, MEMBER)
        self.assertFalse(await self.allowed(message))

    async def test_source_departure_blocks_writes_but_permits_self_leave_without_pretending_to_revoke_reading(self):
        self.source[('m.room.member', MEMBER)].content['membership'] = 'leave'
        self.assertFalse(await self.allowed(event('m.room.encrypted', {'ciphertext': 'opaque'}, sender=MEMBER)))
        self.assertTrue(await self.allowed(event('m.room.member', {'membership': 'leave'}, MEMBER, MEMBER)))
        self.assertEqual(self.private[('m.room.member', MEMBER)].content['membership'], 'join', 'A write check must not pretend it removed native private membership')

    async def test_removal_requires_private_source_and_server_native_and_custom_hierarchy(self):
        remove = event('m.room.member', {'membership': 'leave'}, MEMBER)
        self.assertTrue(await self.allowed(remove))
        self.policy['members'][MEMBER] = ['mod']
        self.assertFalse(await self.allowed(remove))
        self.policy['members'].pop(MEMBER)
        self.server[('m.room.power_levels', '')].content['users'][MEMBER] = 50
        self.assertFalse(await self.allowed(remove))
        self.server[('m.room.power_levels', '')].content['users'].pop(MEMBER)
        self.source[('m.room.power_levels', '')].content['users'][AUTHOR] = 0
        self.assertFalse(await self.allowed(remove))

    async def test_settings_require_revision_current_authority_and_native_state_power(self):
        update = event(SETTINGS, settings(), '')
        self.assertFalse(await self.allowed(update))
        update.content['io.tavern.previous_event'] = '$settings'
        self.assertTrue(await self.allowed(update))
        self.policy['overrides'][SOURCE] = {'users': {AUTHOR: {'create_private_threads': -1}}}
        self.assertFalse(await self.allowed(update))
        self.policy['overrides'] = {}
        self.private[('m.room.power_levels', '')].content['events'][SETTINGS] = 101
        self.assertFalse(await self.allowed(update))

    async def test_server_clock_autoarchive_rejects_opaque_messages_and_survives_restart(self):
        self.private.pop((SETTINGS, ''))
        update = event(SETTINGS, settings(autoArchiveSeconds=3600, activityStartedAt=99999999999999), '')
        with patch('synapse_modules.private_thread.time.time', return_value=1000):
            accepted, replacement = await self.module.check_event_allowed(update, self.private)
            self.assertTrue(accepted)
            self.assertEqual(replacement['content']['activityStartedAt'], 1000000)
            self.private[(SETTINGS, '')] = event(SETTINGS, replacement['content'], '', identity='$new')
        with patch('synapse_modules.private_thread.time.time', return_value=2000):
            self.assertTrue(await self.allowed(event('m.room.encrypted', {'ciphertext': 'opaque'}, identity='$message')))
        self.module = TavernPolicy({}, self.api)
        with patch('synapse_modules.private_thread.time.time', return_value=5600):
            self.assertFalse(await self.allowed(event('m.room.encrypted', {'ciphertext': 'opaque'}, identity='$later')))
            reopen = event(SETTINGS, settings(autoArchiveSeconds=3600, reopen=True, **{'io.tavern.previous_event': '$new'}), '')
            self.assertTrue(await self.allowed(reopen))
            self.assertTrue(await self.allowed(event('m.room.encrypted', {'ciphertext': 'opaque'}, identity='$later')))

    async def test_explicit_archive_and_plaintext_are_rejected_but_public_threads_are_unchanged(self):
        self.assertFalse(await self.allowed(event('m.room.message', {'body': 'plaintext'})))
        self.private[(SETTINGS, '')].content['archived'] = True
        self.assertFalse(await self.allowed(event('m.room.encrypted', {'ciphertext': 'opaque'})))
        self.events['$public'] = event('m.room.encrypted', room=SOURCE, identity='$public')
        self.assertTrue(await self.allowed(event('m.room.encrypted', {'ciphertext': 'opaque', 'm.relates_to': {'rel_type': 'm.thread', 'event_id': '$public'}}, room=SOURCE), self.source))

    async def test_slow_mode_uses_source_ledger_across_private_and_public_messages_without_extending_failed_activity(self):
        self.source[('io.tavern.channel', '')] = event('io.tavern.channel', {'version': 1, 'kind': 'text', 'slowModeSeconds': 10, 'archived': False})
        self.private[(SETTINGS, '')].content['autoArchiveSeconds'] = 3600
        await self.module.threads.activity(ROOM, '$private', 1000000, reset=True)
        with patch('synapse_modules.private_thread.time.time', return_value=1000):
            self.assertTrue(await self.allowed(event('m.room.encrypted', sender=MEMBER, identity='$first')))
        with patch('synapse_modules.private_thread.time.time', return_value=1005):
            self.assertFalse(await self.allowed(event('m.room.encrypted', sender=MEMBER, identity='$second')))
            self.assertEqual(await self.module.threads.activity(ROOM, '$private', 1005000), 1000000)
            self.assertFalse(await self.allowed(event('m.room.encrypted', sender=MEMBER, room=SOURCE, identity='$publictoo'), self.source))
        with patch('synapse_modules.private_thread.time.time', return_value=1010):
            self.assertTrue(await self.allowed(event('m.room.encrypted', sender=MEMBER, identity='$after')))
        rows = self.db.execute('SELECT room_id,user_id FROM tavern_channel_cooldowns').fetchall()
        self.assertEqual(rows, [(SOURCE, MEMBER)])

    async def test_reactions_and_pins_validate_private_target_source_roles_native_power_and_archive(self):
        self.policy['roles'][0]['permissions'] += ['add_reactions', 'pin_messages']
        self.events['$message'] = event('m.room.encrypted')
        reaction = event('m.reaction', {'m.relates_to': {'rel_type': 'm.annotation', 'event_id': '$message', 'key': 'thumbs up'}}, sender=MEMBER)
        pins = event('m.room.pinned_events', {'pinned': ['$message']}, '')
        self.assertTrue(await self.allowed(reaction))
        self.assertTrue(await self.allowed(pins))
        self.events['$message'].room_id = SOURCE
        self.assertFalse(await self.allowed(reaction))
        self.assertFalse(await self.allowed(pins))
        self.events['$message'].room_id = ROOM
        self.policy['overrides'][SOURCE] = {'roles': {'everyone': {'add_reactions': -1, 'pin_messages': -1}}}
        self.assertFalse(await self.allowed(reaction))
        self.assertFalse(await self.allowed(pins))
        self.policy['overrides'] = {}
        self.source[('m.room.power_levels', '')].content['events'] = {'m.room.pinned_events': 100, 'm.reaction': 50}
        self.assertFalse(await self.allowed(reaction))
        self.assertFalse(await self.allowed(pins))
        self.source[('m.room.power_levels', '')].content.pop('events')
        self.private[(SETTINGS, '')].content['archived'] = True
        self.assertFalse(await self.allowed(reaction))
        self.assertFalse(await self.allowed(pins))

    async def test_invalid_authoritative_category_layout_fails_closed(self):
        self.server[(LAYOUT, '')] = event(LAYOUT, {'version': 1, 'categories': [], 'channels': [{'id': SOURCE, 'category': 'missing'}]})
        self.assertFalse(await self.allowed(event('m.room.encrypted')))
        self.assertIsNotNone(await self.module.private_threads.create(AUTHOR, self.request()))


if __name__ == '__main__':
    unittest.main()
