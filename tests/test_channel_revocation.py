import copy
import sqlite3
from types import SimpleNamespace
import unittest

from synapse_modules.channel_admission import ChannelAdmissionPolicy, valid_admissions, revocation_guard
from synapse_modules.channel_revocation import ChannelRevocationWorker
from tests.test_channel_admission import OWNER, ALICE, BOB, ROOM, SERVER, POLICY, event, policy, server


class RevocationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE current_state_events(room_id TEXT,type TEXT);
            CREATE TABLE events(stream_ordering INTEGER,event_id TEXT,room_id TEXT,type TEXT,outlier INTEGER);
            CREATE TABLE rejections(event_id TEXT,reason TEXT);
        ''')
        self.db.execute('INSERT INTO current_state_events VALUES(?,?)', (SERVER, POLICY))
        self.states = {ROOM: {('m.room.create', ''): event({'m.federate': False}),
                             ('m.space.parent', SERVER): event({'canonical': True, 'via': ['test.invalid']}),
                             **{('m.room.member', user): event({'membership': 'join'}) for user in (OWNER, ALICE, BOB)}},
                       SERVER: server(policy(['member']))}
        self.upper, self.removals, self.unavailable = 100, [], False
        self.before_leave = lambda: None
        async def interaction(_name, operation):
            with self.db:
                return operation(self.db.cursor())
        async def read(room):
            if self.unavailable:
                raise RuntimeError('Native state unavailable')
            return copy.deepcopy(self.states[room])
        async def leave(sender, actor, room, membership):
            self.assertEqual((sender, actor, room, membership), (BOB, BOB, ROOM, 'leave'))
            self.assertEqual(revocation_guard.get(), (room, actor))
            self.before_leave()
            proposed = event({'membership': membership}, sender=sender)
            proposed.type, proposed.room_id, proposed.state_key = 'm.room.member', room, actor
            if not await self.policy.check(proposed, await read(room)):
                raise RuntimeError('Native revocation recheck refused')
            self.removals.append(actor)
            self.states[room]['m.room.member', actor] = proposed
        self.api = SimpleNamespace(_store=SimpleNamespace(
            db_pool=SimpleNamespace(runInteraction=interaction), get_room_max_stream_ordering=lambda: self.upper),
            looping_background_call=lambda *_args, **_kwargs: None,
            get_room_state=read, is_mine=lambda user: user.endswith(':test.invalid'), update_room_membership=leave)
        self.policy = ChannelAdmissionPolicy(self.api, lambda value: valid_admissions(value, {'everyone', 'member'}))
        self.worker = ChannelRevocationWorker(self.api, self.policy)

    def dirty(self):
        return dict(self.db.execute('SELECT room_id,revision FROM tavern_channel_dirty').fetchall())

    async def test_startup_discovers_native_policies_and_enqueues_their_private_channels(self):
        await self.worker.initialize()
        self.assertIn(SERVER, self.dirty())
        await self.worker.reconcile(SERVER)
        self.assertIn(ROOM, self.dirty())
        self.assertEqual(self.db.execute('SELECT server_id,room_id FROM tavern_channel_bindings').fetchall(), [(SERVER, ROOM)])

    async def test_stable_denial_removes_only_the_ineligible_member_and_clears_task_context(self):
        await self.worker.initialize()
        await self.worker.reconcile(ROOM)
        self.assertEqual(self.removals, [BOB])
        self.assertEqual(self.states[ROOM]['m.room.member', ALICE].content['membership'], 'join')
        self.assertEqual(self.states[ROOM]['m.room.member', OWNER].content['membership'], 'join')
        self.assertIsNone(revocation_guard.get())

    async def test_grant_restored_during_native_leave_prevents_the_stale_removal(self):
        await self.worker.initialize()
        def regrant():
            self.states[SERVER][POLICY, ''] = event(policy(['member'], [BOB]), '$regranted')
        self.before_leave = regrant
        with self.assertRaisesRegex(RuntimeError, 'recheck refused'):
            await self.worker.reconcile(ROOM)
        self.assertEqual(self.removals, [])
        self.assertEqual(self.states[ROOM]['m.room.member', BOB].content['membership'], 'join')
        self.assertIsNone(revocation_guard.get())

    async def test_transient_native_state_failure_never_removes_a_member(self):
        await self.worker.initialize()
        self.unavailable = True
        with self.assertRaises(RuntimeError):
            await self.worker.reconcile(ROOM)
        self.assertEqual(self.removals, [])

    async def test_dirty_revision_preserves_a_new_change_while_old_work_finishes(self):
        await self.worker.initialize()
        old = self.dirty()[SERVER]
        changed = event({}); changed.type, changed.room_id = POLICY, SERVER
        await self.worker.on_new_event(changed, self.states[SERVER])
        self.db.execute('DELETE FROM tavern_channel_dirty WHERE room_id=? AND revision=?', (SERVER, old))
        self.assertGreater(self.dirty()[SERVER], old)

    async def test_catchup_uses_committed_prefix_and_excludes_rejected_or_outlier_events(self):
        await self.worker.initialize()
        self.db.executemany('INSERT INTO events VALUES(?,?,?,?,?)', [
            (101, '$a', SERVER, POLICY, 0), (102, '$b', ROOM, 'm.room.member', 0),
            (103, '$c', '!rejected', POLICY, 0), (104, '$d', '!outlier', POLICY, 1),
        ])
        self.db.execute('INSERT INTO rejections VALUES(?,?)', ('$c', 'forbidden'))
        self.upper = 101
        await self.worker.catch_up()
        self.assertNotIn(ROOM, self.dirty())
        self.upper = 104
        await self.worker.catch_up()
        self.assertIn(ROOM, self.dirty())
        self.assertNotIn('!rejected', self.dirty()); self.assertNotIn('!outlier', self.dirty())
        self.assertEqual(self.db.execute('SELECT position FROM tavern_channel_cursor').fetchone()[0], 104)

    async def test_restart_rediscovers_private_channels_without_relying_on_old_callbacks(self):
        await self.worker.initialize(); await self.worker.reconcile(SERVER)
        self.db.execute('DELETE FROM tavern_channel_dirty')
        self.upper = 105
        restarted = ChannelRevocationWorker(self.api, self.policy)
        await restarted.initialize()
        self.assertIn(SERVER, self.dirty()); self.assertIn(ROOM, self.dirty())
        self.assertEqual(self.db.execute('SELECT position FROM tavern_channel_cursor').fetchone()[0], 105)


if __name__ == '__main__':
    unittest.main()
