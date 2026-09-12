"""Durable reconciliation of role-managed channel membership.

Only a stable native denial causes removal. Unavailable state and concurrent
policy changes retain work for retry. A private task context rechecks the same
denial in the membership callback, immediately before native self-leave auth.
"""
from collections.abc import Mapping
import logging
import time

try:
    from channel_admission import AUDIENCES, MARKER, POLICY, DENIED, content, revocation_guard
except ImportError:
    from synapse_modules.channel_admission import AUDIENCES, MARKER, POLICY, DENIED, content, revocation_guard

logger = logging.getLogger(__name__)
CHANGES = frozenset({POLICY, 'm.room.member', 'm.space.parent', 'm.space.child'})


class ChannelRevocationWorker:
    def __init__(self, api, policy):
        self.api, self.policy = api, policy
        self.ready = self.running = False
        self.initial = api._store.get_room_max_stream_ordering()
        api.looping_background_call(self.sweep, 3000, desc='tavern-channel-revocation')

    async def transaction(self, name, operation):
        return await self.api._store.db_pool.runInteraction('tavern_channel_' + name, operation)

    @staticmethod
    def enqueue(txn, room):
        txn.execute('INSERT INTO tavern_channel_dirty(room_id,revision,next_attempt) VALUES(?,1,0) '
                    'ON CONFLICT(room_id) DO UPDATE SET revision=tavern_channel_dirty.revision+1,next_attempt=0', (room,))

    async def initialize(self):
        if self.ready:
            return
        def initialize(txn):
            txn.execute('CREATE TABLE IF NOT EXISTS tavern_channel_dirty(room_id TEXT PRIMARY KEY,revision BIGINT NOT NULL,next_attempt BIGINT NOT NULL)')
            txn.execute('CREATE TABLE IF NOT EXISTS tavern_channel_bindings(server_id TEXT NOT NULL,room_id TEXT NOT NULL,PRIMARY KEY(server_id,room_id))')
            txn.execute('CREATE TABLE IF NOT EXISTS tavern_channel_cursor(id INTEGER PRIMARY KEY,position BIGINT NOT NULL)')
            # Reconcile current state on every startup, including assignments
            # accepted before this module was loaded. Never expire revocations.
            txn.execute('SELECT DISTINCT room_id FROM current_state_events WHERE type=?', (POLICY,))
            scopes = {row[0] for row in txn.fetchall()}
            txn.execute('SELECT server_id,room_id FROM tavern_channel_bindings')
            for server, room in txn.fetchall():
                scopes.update((server, room))
            for room in scopes:
                self.enqueue(txn, room)
            txn.execute('INSERT INTO tavern_channel_cursor(id,position) VALUES(1,?) '
                        'ON CONFLICT(id) DO UPDATE SET position=excluded.position', (self.initial,))
        await self.transaction('initialize', initialize)
        self.ready = True

    async def on_new_event(self, event, state):
        if event.type not in CHANGES:
            return
        await self.initialize()
        await self.transaction('enqueue', lambda txn: self.enqueue(txn, event.room_id))

    async def catch_up(self):
        upper = self.api._store.get_room_max_stream_ordering()
        def scan(txn):
            txn.execute('SELECT position FROM tavern_channel_cursor WHERE id=1')
            lower = txn.fetchone()[0]
            txn.execute('SELECT e.stream_ordering,e.room_id,e.type FROM events e LEFT JOIN rejections r USING(event_id) '
                        'WHERE e.stream_ordering>? AND e.stream_ordering<=? AND e.outlier=? AND r.reason IS NULL '
                        'ORDER BY e.stream_ordering LIMIT 300', (lower, upper, False))
            rows = txn.fetchall()
            for _, room, kind in rows:
                if kind in CHANGES:
                    self.enqueue(txn, room)
            position = rows[-1][0] if len(rows) == 300 else upper
            txn.execute('UPDATE tavern_channel_cursor SET position=? WHERE id=1 AND position=?', (position, lower))
        await self.transaction('catch_up', scan)

    async def reconcile(self, room):
        state = await self.api.get_room_state(room)
        if content(state, 'm.room.create').get('type') == 'm.space':
            policy = content(state, POLICY)
            opted_in = MARKER in policy or AUDIENCES in policy
            if opted_in and not self.policy.valid_policy(policy):
                raise ValueError('Invalid admission policy')
            audience = policy.get(AUDIENCES, {}) if opted_in else {}
            if not isinstance(audience, Mapping):
                raise ValueError('Invalid admission policy')
            def bindings(txn):
                txn.execute('SELECT room_id FROM tavern_channel_bindings WHERE server_id=?', (room,))
                previous = {row[0] for row in txn.fetchall()}
                txn.execute('DELETE FROM tavern_channel_bindings WHERE server_id=?', (room,))
                for channel in audience:
                    txn.execute('INSERT INTO tavern_channel_bindings(server_id,room_id) VALUES(?,?) ON CONFLICT DO NOTHING', (room, channel))
                for channel in previous | set(audience):
                    self.enqueue(txn, channel)
            await self.transaction('bindings', bindings)
            return
        _, scopes = await self.policy.scopes(room, state)
        if not scopes:
            return
        removed = 0
        for (kind, actor), event in state.items():
            if kind != 'm.room.member' or event.content.get('membership') not in {'join', 'invite'} or not self.api.is_mine(actor):
                continue
            denial = await self.policy.denial(room, state, actor)
            if denial is None:
                continue
            if denial != DENIED:
                raise ValueError('Admission needs retry')
            if removed >= 50:
                raise ValueError('More membership removals remain')
            guard = revocation_guard.set((room, actor))
            try:
                # This uses native self-leave, which works even if the target
                # has high room power. The callback rechecks current denial.
                await self.api.update_room_membership(actor, actor, room, 'leave')
            finally:
                revocation_guard.reset(guard)
            current = await self.api.get_room_state(room)
            if content(current, 'm.room.member', actor).get('membership') in {'join', 'invite'}:
                raise ValueError('Native membership removal is pending')
            removed += 1

    async def sweep(self):
        if self.running:
            return
        self.running = True
        try:
            await self.initialize()
            await self.catch_up()
            def due(txn):
                txn.execute('SELECT room_id,revision FROM tavern_channel_dirty WHERE next_attempt<=? ORDER BY next_attempt,room_id LIMIT 8', (int(time.time()),))
                return txn.fetchall()
            for room, revision in await self.transaction('due', due):
                try:
                    from twisted.internet.defer import ensureDeferred
                    await ensureDeferred(self.reconcile(room)).addTimeout(10, self.api.http_client.reactor)
                except Exception:
                    # Do not emit private room/member identifiers or upstream bodies.
                    logger.warning('Private-channel membership reconciliation will retry.')
                    await self.transaction('retry', lambda txn: txn.execute(
                        'UPDATE tavern_channel_dirty SET next_attempt=? WHERE room_id=? AND revision=?',
                        (int(time.time()) + 15, room, revision)))
                else:
                    await self.transaction('done', lambda txn: txn.execute(
                        'DELETE FROM tavern_channel_dirty WHERE room_id=? AND revision=?', (room, revision)))
        except Exception:
            logger.warning('Private-channel reconciliation is temporarily unavailable.')
        finally:
            self.running = False
