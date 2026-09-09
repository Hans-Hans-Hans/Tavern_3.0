"""Post-persist Space membership notices; no ciphertext or private-room forwarding.

The small datastore adapter targets pinned Synapse 1.160.0, like channel cooldowns.
The native event stream repairs missed callbacks; delivery never runs in event auth.
"""
from collections.abc import Mapping
import hashlib
import hmac
from io import BytesIO
import json
import logging
from pathlib import Path
import re
import time
try:
    from channel_policy import valid_channel
except ImportError:
    from synapse_modules.channel_policy import valid_channel

SYSTEM_MESSAGES = 'io.tavern.server.system_messages'
TTL = 1800
BATCH = 100
MAX_BACKLOG = 20000
MAX_PENDING = 2000
MAX_AUDIENCE = 201
EVENT_TIMEOUT = 15
LOG = logging.getLogger('tavern.system_messages')


def identifier(value, prefix):
    return isinstance(value, str) and bool(re.fullmatch(re.escape(prefix) + r'[^\s\x00-\x1f\x7f]{1,510}', value))


def value(state, kind, key=''):
    event = state.get((kind, key))
    return event.content if event else {}


def valid_settings(data):
    return (isinstance(data, Mapping)
        and set(data) == {'version', 'enabled', 'channelId', 'hookId', 'joins', 'leaves', 'io.tavern.previous_event'}
        and type(data['version']) is int and data['version'] == 1
        and all(type(data[key]) is bool for key in ('enabled', 'joins', 'leaves'))
        and (data['io.tavern.previous_event'] is None or identifier(data['io.tavern.previous_event'], '$'))
        and (identifier(data['channelId'], '!') or data['channelId'] == '' and not data['enabled'])
        and isinstance(data['hookId'], str) and bool(re.fullmatch(r'[a-z0-9_-]{1,64}', data['hookId']) or data['hookId'] == '' and not data['enabled'])
        and (not data['enabled'] or data['joins'] or data['leaves']))


def signed_headers(key, purpose, body, now=None):
    timestamp = str(int(time.time() if now is None else now))
    signed = '\n'.join(('v1', purpose, timestamp, hashlib.sha256(body).hexdigest())).encode()
    return {b'Content-Type': [b'application/json'], b'X-Tavern-System-Timestamp': [timestamp.encode()],
        b'X-Tavern-System-Signature': [hmac.new(key, signed, hashlib.sha256).hexdigest().encode()]}


class SystemMessagesPolicy:
    valid_channel = staticmethod(valid_channel)
    def __init__(self, config, api, model):
        self.api, self.model = api, model
        self.url = config.get('privacy_api_url', '')
        self.key_file = Path(config.get('privacy_key_file', '/data/tavern-privacy.key'))
        self.enabled = config.get('system_messages_enabled', False) is True
        self.ready = self.running = False
        # This is the safe committed prefix, not max(events.stream_ordering).
        # Snapshot before the first timer/callback; first installation skips history.
        self.initial = api._store.get_room_max_stream_ordering() if self.enabled else 0
        if self.enabled:
            api.looping_background_call(self.sweep, 3000, desc='tavern_system_messages')

    def may_configure(self, event, state):
        create = state.get(('m.room.create', ''))
        current = state.get((SYSTEM_MESSAGES, ''))
        if (not create or create.content.get('type') != 'm.space' or create.content.get('m.federate') is not False
            or getattr(event, 'state_key', None) != '' or not valid_settings(event.content)
            or value(state, 'm.room.member', event.sender).get('membership') != 'join'
            or event.content['io.tavern.previous_event'] != (current.event_id if current else None)):
            return False
        powers = value(state, 'm.room.power_levels')
        if not isinstance(powers.get('events', {}), Mapping): return False
        minimum = powers.get('events', {}).get(SYSTEM_MESSAGES, powers.get('state_default', 50))
        native = self.model.native_member_power(state, event.sender)
        if type(minimum) is not int or native is None or native < minimum: return False
        policy = value(state, self.model.POLICY)
        return (self.model.valid_policy(policy) and 'manage_server' in self.model.permissions(policy, event.sender)
                if (self.model.POLICY, '') in state else create.sender == event.sender)

    async def check(self, event, state):
        if event.type == 'm.room.redaction':
            target = getattr(event, 'redacts', None) or event.content.get('redacts')
            previous = await self.api._store.get_event(target, allow_none=True) if target else None
            if previous and previous.type == SYSTEM_MESSAGES: return False
        if event.type != SYSTEM_MESSAGES: return True
        if not self.may_configure(event, state): return False
        if event.content['enabled']:
            target = event.content['channelId']
            child = await self.api.get_room_state(target)
            if not self.destination(event.room_id, target, state, child): return False
            if value(child, 'm.room.member', event.sender).get('membership') != 'join': return False
            child = await self.api.get_room_state(target)
            if value(child, 'm.room.member', event.sender).get('membership') != 'join': return False
        fresh = await self.api.get_room_state(event.room_id)
        return self.may_configure(event, fresh) and (not event.content['enabled'] or self.destination(event.room_id, event.content['channelId'], fresh, child))

    @staticmethod
    def destination(server, room, parent, child):
        create = value(child, 'm.room.create')
        parents = [key for (kind, key), event in child.items() if kind == 'm.space.parent' and event.content.get('canonical') is True and event.content.get('via')]
        return (create.get('type') not in ('m.space', 'io.tavern.private_thread')
            and 'io.tavern.private_thread' not in create and create.get('m.federate') is False
            and value(child, 'm.room.encryption').get('algorithm') == 'm.megolm.v1.aes-sha2'
            and ('m.room.tombstone', '') not in child and parents == [server]
            and bool(value(parent, 'm.space.child', room).get('via')))

    async def initialize(self):
        if self.ready: return
        def create(txn):
            txn.execute('CREATE TABLE IF NOT EXISTS tavern_system_cursor(id INTEGER PRIMARY KEY,position BIGINT NOT NULL)')
            txn.execute('CREATE TABLE IF NOT EXISTS tavern_system_outbox(event_id TEXT PRIMARY KEY,expires BIGINT NOT NULL,next_attempt BIGINT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)')
            txn.execute('INSERT INTO tavern_system_cursor(id,position) VALUES(1,?) ON CONFLICT(id) DO NOTHING', (self.initial,))
        await self.api._store.db_pool.runInteraction('tavern_system_initialize', create)
        self.ready = True

    async def on_new_event(self, event, state):
        if not self.enabled or event.type != 'm.room.member': return
        create = value(state, 'm.room.create')
        config = value(state, SYSTEM_MESSAGES)
        if create.get('type') != 'm.space' or create.get('m.federate') is not False or not valid_settings(config) or not config['enabled']: return
        await self.initialize()
        now = int(time.time())
        def enqueue(txn):
            txn.execute('SELECT COUNT(*) FROM tavern_system_outbox')
            if txn.fetchone()[0] >= MAX_PENDING: return
            txn.execute('INSERT INTO tavern_system_outbox(event_id,expires,next_attempt) VALUES(?,?,?) ON CONFLICT(event_id) DO NOTHING', (event.event_id, now + TTL, now))
        await self.api._store.db_pool.runInteraction('tavern_system_ingest', enqueue)

    async def catch_up(self):
        # Index-bounded forward batches, a safe committed upper bound, and a
        # finite recovery window prevent a bot outage from scanning all history.
        upper, now = self.api._store.get_room_max_stream_ordering(), int(time.time())
        def scan(txn):
            txn.execute('DELETE FROM tavern_system_outbox WHERE expires<=?', (now,))
            txn.execute('SELECT position FROM tavern_system_cursor WHERE id=1')
            previous = txn.fetchone()[0]
            lower = max(previous, upper - MAX_BACKLOG)
            txn.execute('SELECT COUNT(*) FROM tavern_system_outbox')
            capacity = MAX_PENDING - txn.fetchone()[0]
            if capacity <= 0: return
            txn.execute('SELECT e.stream_ordering,e.event_id,e.type,e.origin_server_ts FROM events e LEFT JOIN rejections r USING(event_id) WHERE e.stream_ordering>? AND e.stream_ordering<=? AND e.outlier=? AND r.reason IS NULL ORDER BY e.stream_ordering LIMIT ?', (lower, upper, False, min(BATCH, capacity)))
            rows = txn.fetchall()
            for _, identity, kind, stamp in rows:
                if kind == 'm.room.member' and type(stamp) is int and now * 1000 - TTL * 1000 <= stamp <= now * 1000 + 30000:
                    txn.execute('INSERT INTO tavern_system_outbox(event_id,expires,next_attempt) VALUES(?,?,?) ON CONFLICT(event_id) DO NOTHING', (identity, min(now + TTL, stamp // 1000 + TTL), now))
            position = rows[-1][0] if len(rows) == min(BATCH, capacity) else upper
            txn.execute('UPDATE tavern_system_cursor SET position=? WHERE id=1 AND position=?', (position, previous))
        await self.api._store.db_pool.runInteraction('tavern_system_catch_up', scan)

    async def envelope(self, identity):
        event = await self.api._store.get_event(identity, allow_none=True)
        if not event or event.type != 'm.room.member' or not self.api.is_mine(event.sender): return None
        # Pinned state controller returns persisted state AFTER this exact event.
        state = await self.api._storage_controllers.state.get_state_for_event(identity)
        create, config = value(state, 'm.room.create'), value(state, SYSTEM_MESSAGES)
        if create.get('type') != 'm.space' or create.get('m.federate') is not False or not valid_settings(config) or not config['enabled']: return None
        membership = event.content.get('membership')
        # Synapse's state-context builder sets replaces_state from actual prior
        # state. Fetch and verify that event; never trust a prev_content claim.
        prior = event.unsigned.get('replaces_state')
        previous = await self.api._store.get_event(prior, allow_none=True) if prior else None
        if prior and previous is None: return None
        if previous and (previous.room_id != event.room_id or previous.type != 'm.room.member' or previous.state_key != event.state_key): return None
        old = previous.content.get('membership') if previous else None
        change = 'join' if membership == 'join' and old != 'join' else 'leave' if membership == 'leave' and old == 'join' else None
        if not change or not config['joins' if change == 'join' else 'leaves']: return None
        target = config['channelId']
        child = await self.api.get_room_state(target)
        if not self.destination(event.room_id, target, state, child): return None
        candidates = {key for (kind, key), item in child.items() if kind == 'm.room.member' and item.content.get('membership') == 'join'}
        if change == 'join': candidates.add(event.state_key)
        if len(candidates) > MAX_AUDIENCE: return None
        audience = sorted(user for user in candidates if value(state, 'm.room.member', user).get('membership') == 'join')
        if not audience: return None
        return {'version': 1, 'eventId': identity, 'serverId': event.room_id, 'configEventId': state[(SYSTEM_MESSAGES, '')].event_id,
            'channelId': target, 'hookId': config['hookId'], 'userId': event.state_key, 'change': change,
            'occurredAt': event.origin_server_ts, 'audience': audience}

    async def post(self, body):
        # Pinned SimpleHttpClient.agent performs one request without treq's
        # redirect wrapper. Avoid post_json_get_json's debug payload logging
        # and unbounded readBody; only this fixed signed private route is used.
        from canonicaljson import encode_canonical_json
        from twisted.internet.defer import ensureDeferred
        from twisted.web.client import FileBodyProducer
        from twisted.web.http_headers import Headers
        from synapse.http.client import read_body_with_max_size
        from synapse.logging.context import make_deferred_yieldable
        key = bytes.fromhex(self.key_file.read_text().strip())
        if len(key) != 32 or not self.url: raise ValueError('Missing internal signing configuration')
        raw = encode_canonical_json(body)
        client = self.api.http_client
        async def request():
            response = await make_deferred_yieldable(client.agent.request(b'POST', (self.url + '/api/internal/system-events').encode(),
                Headers(signed_headers(key, 'system-events', raw)), FileBodyProducer(BytesIO(raw))))
            output = BytesIO()
            await make_deferred_yieldable(read_body_with_max_size(response, output, 8192))
            if response.code not in (200, 202): raise ValueError('Unconfirmed durable ingestion')
            return json.loads(output.getvalue())
        return await ensureDeferred(request()).addTimeout(5, client.reactor)

    async def deliver_event(self, identity):
        body = await self.envelope(identity)
        if body:
            response = await self.post(body)
            if not isinstance(response, Mapping) or response.get('accepted') is not True:
                raise ValueError('Unconfirmed durable ingestion')

    async def sweep(self):
        if not self.enabled or self.running: return
        self.running = True
        try:
            await self.initialize()
            await self.catch_up()
            def due(txn):
                txn.execute('SELECT event_id,attempts FROM tavern_system_outbox WHERE next_attempt<=? ORDER BY next_attempt LIMIT 10', (int(time.time()),))
                return txn.fetchall()
            rows = await self.api._store.db_pool.runInteraction('tavern_system_due', due)
            for identity, attempts in rows:
                try:
                    # Catch-up encounters unrelated remote membership too. A
                    # full native state lookup can wait for partial-state sync;
                    # bound the whole attempt, not only its final HTTP call.
                    from twisted.internet.defer import ensureDeferred
                    reactor = self.api.http_client.reactor
                    await ensureDeferred(self.deliver_event(identity)).addTimeout(EVENT_TIMEOUT, reactor)
                    def finish(txn): txn.execute('DELETE FROM tavern_system_outbox WHERE event_id=?', (identity,))
                    await self.api._store.db_pool.runInteraction('tavern_system_delivered', finish)
                except Exception:
                    def retry(txn): txn.execute('UPDATE tavern_system_outbox SET attempts=attempts+1,next_attempt=? WHERE event_id=?', (int(time.time()) + min(300, 2 ** min(attempts + 1, 8)), identity))
                    await self.api._store.db_pool.runInteraction('tavern_system_retry', retry)
        except Exception:
            LOG.warning('System notice ingestion is unavailable; bounded native recovery will retry.')
        finally:
            self.running = False
