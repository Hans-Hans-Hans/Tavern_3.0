import sqlite3
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from synapse_modules.channel_policy import ChannelPolicy
from synapse_modules.tavern_policy import permissions, rank
from synapse_modules.thread_policy import THREAD, ThreadPolicy, valid_thread


def event(kind, sender='@author:test', content=None, key=None, identity='$event', room='!room:test'):
    value = SimpleNamespace(type=kind, sender=sender, content=content or {}, state_key=key, event_id=identity, room_id=room)
    value.get_dict = lambda: {'type': kind, 'sender': sender, 'room_id': room, 'state_key': key, 'content': dict(value.content)}
    return value


def metadata(**changes):
    return {'version': 1, 'title': 'Topic', 'tags': ['help'], 'closed': False, 'locked': False, 'archived': False, 'autoArchiveSeconds': 0, **changes}


class ThreadPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = sqlite3.connect(':memory:')
        self.events = {'$root': event('m.room.encrypted', identity='$root')}
        async def lookup(identity, allow_none=False):
            return self.events.get(identity)
        async def interaction(_name, callback):
            cursor = self.db.cursor()
            try:
                value = callback(cursor)
                self.db.commit()
                return value
            except Exception:
                self.db.rollback()
                raise
            finally:
                cursor.close()
        self.api = SimpleNamespace(_store=SimpleNamespace(get_event=lookup, db_pool=SimpleNamespace(runInteraction=interaction)))
        self.policy = ThreadPolicy(self.api, ChannelPolicy(self.api, permissions, rank))
        self.state = {('m.room.power_levels', ''): event('m.room.power_levels', content={'users': {'@mod:test': 50}, 'events': {THREAD: 0}, 'redact': 50})}
        for user in ('@author:test', '@member:test', '@mod:test'):
            self.state[('m.room.member', user)] = event('m.room.member', content={'membership': 'join'})

    async def asyncTearDown(self):
        self.db.close()

    async def apply(self, value, sender='@author:test'):
        update = event(THREAD, sender=sender, key='$root', content=value)
        self.assertTrue(await self.policy.check(update, self.state, []))
        accepted, replacement = await self.policy.finish(update, self.state)
        self.assertTrue(accepted)
        self.state[(THREAD, '$root')] = event(THREAD, content=replacement['content'], key='$root')

    async def test_thread_owner_can_edit_but_cannot_lock_or_escape_moderator_lock(self):
        self.assertFalse(await self.policy.check(event(THREAD, sender='@member:test', key='$root', content=metadata()), self.state, []))
        self.assertFalse(await self.policy.check(event(THREAD, key='$root', content=metadata(locked=True)), self.state, []))
        await self.apply(metadata())
        await self.apply(metadata(locked=True), '@mod:test')
        self.assertFalse(await self.policy.check(event(THREAD, key='$root', content=metadata(locked=False)), self.state, []))
        self.assertFalse(await self.policy.check(event(THREAD, key='$root', content=metadata(locked=True, title='Changed')), self.state, []))
        await self.apply(metadata(locked=False), '@mod:test')

    async def test_native_power_and_room_root_identity_are_required(self):
        self.events['$foreign'] = event('m.room.encrypted', room='!other:test')
        self.events['$reply'] = event('m.room.encrypted', content={'m.relates_to': {'rel_type': 'm.thread', 'event_id': '$root'}})
        for identity in ('$missing', '$foreign', '$reply'):
            self.assertFalse(await self.policy.check(event(THREAD, key=identity, content=metadata()), self.state, []))
        self.state[('m.room.power_levels', '')].content['events'][THREAD] = 50
        self.assertFalse(await self.policy.check(event(THREAD, key='$root', content=metadata()), self.state, []))

    async def test_locked_closed_archived_block_explicit_encrypted_replies(self):
        reply = event('m.room.encrypted', sender='@mod:test', content={'ciphertext': 'opaque', 'm.relates_to': {'rel_type': 'm.thread', 'event_id': '$root'}})
        for field in ('closed', 'archived', 'locked'):
            self.state[(THREAD, '$root')] = event(THREAD, content=metadata(**{field: True}))
            self.assertFalse(await self.policy.check(reply, self.state, []))
            self.assertTrue(await self.policy.check(event('m.room.encrypted', content={'ciphertext': 'opaque main room message'}), self.state, []))

    async def test_autoarchive_uses_durable_server_activity_and_cannot_be_extended_by_title_edits(self):
        with patch('synapse_modules.thread_policy.time.time', return_value=1000):
            await self.apply(metadata(autoArchiveSeconds=3600, updatedAt=99999999999999, activityStartedAt=99999999999999))
        stored = self.state[(THREAD, '$root')].content
        self.assertEqual(stored['activityStartedAt'], 1000000)
        self.assertEqual(stored['updatedAt'], 1000000)
        reply = event('m.room.encrypted', content={'m.relates_to': {'rel_type': 'm.thread', 'event_id': '$root'}}, identity='$reply')
        with patch('synapse_modules.thread_policy.time.time', return_value=2000):
            self.assertTrue(await self.policy.check(reply, self.state, []))
            self.assertEqual(await self.policy.finish(reply, self.state), (True, None))
        with patch('synapse_modules.thread_policy.time.time', return_value=5500):
            await self.apply(metadata(autoArchiveSeconds=3600, title='Edited title'))
            self.assertEqual(self.state[(THREAD, '$root')].content['activityStartedAt'], 2000000)
        restarted = ThreadPolicy(self.api, self.policy.channels)
        with patch('synapse_modules.thread_policy.time.time', return_value=5600):
            self.assertFalse(await restarted.check(reply, self.state, []))
            await self.apply(metadata(autoArchiveSeconds=3600, reopen=True))
            self.assertTrue(await restarted.check(reply, self.state, []))

    async def test_thread_restrictions_cannot_be_redacted(self):
        self.events['$policy'] = event(THREAD, key='$root', content=metadata(locked=True))
        redaction = event('m.room.redaction', sender='@mod:test', content={'redacts': '$policy'})
        self.assertFalse(await self.policy.check(redaction, self.state, []))

    def test_malformed_metadata_and_inactivity_intervals_rejected(self):
        for data in (metadata(autoArchiveSeconds=True), metadata(autoArchiveSeconds=1), metadata(tags=['x' * 33]), metadata(locked='yes'), metadata(title=['array'])):
            self.assertFalse(valid_thread(data))


if __name__ == '__main__':
    unittest.main()
