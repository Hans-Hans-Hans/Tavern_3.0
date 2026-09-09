"""Native post-persist outbox, exact-event audience and bounded recovery."""
import copy
import asyncio
import json
from pathlib import Path
import sqlite3
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
from synapse_modules import server_system_messages as native_system

from synapse_modules import tavern_policy as model
from synapse_modules.server_system_messages import SystemMessagesPolicy, SYSTEM_MESSAGES, TTL, MAX_BACKLOG, valid_settings

SERVER, ROOM, OWNER, BOT, ALICE = '!server:test', '!room:test', '@owner:test', '@bot:test', '@alice:test'


def event(kind, body=None, key='', identity='$event', room=SERVER, sender=OWNER):
    return SimpleNamespace(type=kind, content=body or {}, state_key=key, event_id=identity,
                           room_id=room, sender=sender, unsigned={}, origin_server_ts=int(time.time()*1000))


def settings(**changes):
    return {'version': 1, 'enabled': True, 'channelId': ROOM, 'hookId': 'notices', 'joins': True,
            'leaves': True, 'io.tavern.previous_event': None, **changes}


def states():
    parent = {('m.room.create', ''): event('m.room.create', {'type': 'm.space', 'm.federate': False}),
              ('m.room.power_levels', ''): event('m.room.power_levels', {'users': {OWNER: 100}}),
              ('m.space.child', ROOM): event('m.space.child', {'via': ['test']}, key=ROOM),
              (SYSTEM_MESSAGES, ''): event(SYSTEM_MESSAGES, settings(), identity='$config')}
    child = {('m.room.create', ''): event('m.room.create', {'m.federate': False}, room=ROOM),
             ('m.space.parent', SERVER): event('m.space.parent', {'canonical': True, 'via': ['test']}, key=SERVER, room=ROOM),
             ('m.room.encryption', ''): event('m.room.encryption', {'algorithm': 'm.megolm.v1.aes-sha2'}, room=ROOM)}
    for user in (OWNER, BOT, ALICE):
        parent[('m.room.member', user)] = event('m.room.member', {'membership': 'join'}, key=user)
        child[('m.room.member', user)] = event('m.room.member', {'membership': 'join'}, key=user, room=ROOM)
    return parent, child


class Pool:
    def __init__(self, db): self.db = db
    async def runInteraction(self, name, callback):
        with self.db: return callback(self.db.cursor())


class NativeSystemMessagesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.db = sqlite3.connect(str(Path(self.directory.name)/'native.db'))
        self.addCleanup(self.db.close)
        self.db.executescript('CREATE TABLE events(stream_ordering INTEGER PRIMARY KEY,event_id TEXT,type TEXT,origin_server_ts BIGINT,outlier BOOLEAN); CREATE TABLE rejections(event_id TEXT,reason TEXT);')
        self.parent, self.child = states(); self.events, self.at_event = {}, {}
        self.head = 100
        async def get_event(identity, **_): return self.events.get(identity)
        self.api = SimpleNamespace(_store=SimpleNamespace(db_pool=Pool(self.db), get_event=get_event, get_room_max_stream_ordering=lambda:self.head),
            looping_background_call=lambda *args, **kwargs: None, is_mine=lambda user:user.endswith(':test'),
            get_room_state=AsyncMock(side_effect=lambda room:self.parent if room==SERVER else self.child),
            _storage_controllers=SimpleNamespace(state=SimpleNamespace(get_state_for_event=AsyncMock(side_effect=lambda identity:self.at_event[identity]))),
            http_client=SimpleNamespace(reactor=object(), post_json_get_json=AsyncMock(return_value={'accepted': True})))
        class FakeDeferred:
            """Portable stand-in for pinned Twisted's cancellable deadline."""
            def __init__(self, awaitable): self.awaitable=awaitable
            def addTimeout(inner, seconds, reactor):
                self.assertIs(reactor,self.api.http_client.reactor)
                return asyncio.wait_for(inner.awaitable,seconds)
        native_timer=unittest.mock.patch.dict('sys.modules',{'twisted.internet.defer':SimpleNamespace(ensureDeferred=FakeDeferred)})
        native_timer.start(); self.addCleanup(native_timer.stop)
        self.key = Path(self.directory.name)/'bridge.key'; self.key.write_text('12'*32)
        self.config = {'system_messages_enabled': True, 'privacy_api_url': 'http://tavern-api:8090', 'privacy_key_file': str(self.key)}
        self.policy = SystemMessagesPolicy(self.config, self.api, model)
        self.post_patch = unittest.mock.patch.object(SystemMessagesPolicy, 'post', self.api.http_client.post_json_get_json)
        self.post_patch.start(); self.addCleanup(self.post_patch.stop)

    def add(self, identity='$join', membership='join', old='leave', position=101):
        current = event('m.room.member', {'membership': membership}, key=ALICE, identity=identity)
        previous = event('m.room.member', {'membership': old}, key=ALICE, identity=identity+'-before')
        current.unsigned = {'replaces_state': previous.event_id, 'prev_content': {'membership': 'untrusted'}}
        self.events.update({identity: current, previous.event_id: previous})
        snapshot = copy.deepcopy(self.parent); snapshot[('m.room.member', ALICE)] = current
        self.at_event[identity] = snapshot
        self.db.execute('INSERT INTO events VALUES(?,?,?,?,?)', (position, identity, current.type, current.origin_server_ts, False)); self.db.commit()
        self.head = max(self.head, position)
        return current

    async def test_disabled_has_no_database_timer_or_historical_broadcast(self):
        disabled = SystemMessagesPolicy({}, None, model)
        await disabled.on_new_event(event('m.room.member'), {}); await disabled.sweep()
        self.add(position=99)
        await self.policy.sweep()
        self.api.http_client.post_json_get_json.assert_not_awaited()
        self.assertEqual(self.db.execute('SELECT position FROM tavern_system_cursor').fetchone()[0],100)

    async def test_callback_is_durable_deduplicated_and_restart_repairs_missed_callback(self):
        current = self.add()
        await self.policy.on_new_event(current, self.at_event[current.event_id])
        await self.policy.on_new_event(current, self.at_event[current.event_id])
        self.assertEqual(self.db.execute('SELECT count(*) FROM tavern_system_outbox').fetchone()[0], 1)
        restart = SystemMessagesPolicy(self.config, self.api, model)
        await restart.sweep()
        self.assertEqual(self.api.http_client.post_json_get_json.await_count, 1)
        self.add('$missed', position=102)
        await restart.sweep()
        self.assertEqual(self.api.http_client.post_json_get_json.await_count, 2)
        self.assertEqual(self.db.execute('SELECT count(*) FROM tavern_system_outbox').fetchone()[0], 0)

    async def test_retry_requires_exact_durable_ack_and_survives_restart(self):
        self.add(); self.api.http_client.post_json_get_json.return_value = {'accepted': 1}
        await self.policy.sweep()
        self.assertEqual(self.db.execute('SELECT attempts FROM tavern_system_outbox').fetchone()[0], 1)
        self.db.execute('UPDATE tavern_system_outbox SET next_attempt=0'); self.db.commit()
        self.api.http_client.post_json_get_json.return_value = {'accepted': True}
        await SystemMessagesPolicy(self.config, self.api, model).sweep()
        self.assertEqual(self.db.execute('SELECT count(*) FROM tavern_system_outbox').fetchone()[0],0)

    async def test_partial_state_wait_times_out_and_next_event_still_delivers(self):
        self.add('$stalled',position=101); self.add('$ready',position=102)
        cancelled=asyncio.Event()
        original=self.api._storage_controllers.state.get_state_for_event
        async def read(identity):
            if identity=='$stalled':
                try: await asyncio.Event().wait()
                finally: cancelled.set()
            return await original(identity)
        self.api._storage_controllers.state.get_state_for_event=read
        self.api.http_client.reactor=object()
        deadlines=[]
        class FakeDeferred:
            """Portable deadline adapter; production uses pinned Twisted."""
            def __init__(self,awaitable): self.awaitable=awaitable
            def addTimeout(inner,seconds,reactor):
                self.assertIs(reactor,self.api.http_client.reactor)
                deadlines.append(seconds)
                return asyncio.wait_for(inner.awaitable,seconds)
        with unittest.mock.patch.dict('sys.modules',{'twisted.internet.defer':SimpleNamespace(ensureDeferred=FakeDeferred)}), unittest.mock.patch.object(native_system,'EVENT_TIMEOUT',0.01):
            await asyncio.wait_for(self.policy.sweep(),1)
        self.assertTrue(cancelled.is_set()); self.assertFalse(self.policy.running)
        self.assertEqual(deadlines,[0.01,0.01])
        self.assertEqual(self.db.execute('SELECT event_id,attempts FROM tavern_system_outbox').fetchall(),[('$stalled',1)])
        self.assertEqual(self.api.http_client.post_json_get_json.await_count,1)

    async def test_profile_updates_bans_and_unknown_previous_event_are_not_joins(self):
        for index, (membership,old) in enumerate((('join','join'),('ban','join'),('invite','leave'))):
            item = self.add('$ignored'+str(index),membership,old,101+index)
            self.assertIsNone(await self.policy.envelope(item.event_id))
        current=self.add('$unknown',position=110); self.events.pop('$unknown-before')
        self.assertIsNone(await self.policy.envelope(current.event_id))

    async def test_audience_comes_from_exact_event_and_never_private_channel_state(self):
        current=self.add()
        self.child[('m.room.member','@late:test')]=event('m.room.member',{'membership':'join'},key='@late:test')
        self.parent[('m.room.member','@late:test')]=event('m.room.member',{'membership':'join'},key='@late:test')
        envelope=await self.policy.envelope(current.event_id)
        self.assertNotIn('@late:test',envelope['audience'])
        self.assertEqual(envelope['configEventId'],'$config')
        self.at_event[current.event_id][('m.room.create','')].content['type']='io.tavern.private_thread'
        self.assertIsNone(await self.policy.envelope(current.event_id))

    async def test_leave_audience_excludes_departed_subject_even_if_still_in_destination(self):
        current=self.add(membership='leave',old='join')
        envelope=await self.policy.envelope(current.event_id)
        self.assertEqual(envelope['change'],'leave'); self.assertNotIn(ALICE,envelope['audience'])

    async def test_bounded_catchup_skips_expired_rejected_outliers_and_far_history(self):
        await self.policy.initialize()
        self.add('$far',position=101)
        self.add('$expired',position=102); self.db.execute('UPDATE events SET origin_server_ts=1 WHERE event_id=?',('$expired',))
        self.add('$rejected',position=103); self.db.execute('INSERT INTO rejections VALUES(?,?)',('$rejected','forbidden'))
        self.add('$outlier',position=104); self.db.execute('UPDATE events SET outlier=1 WHERE event_id=?',('$outlier',))
        self.head=MAX_BACKLOG+200
        self.add('$recent',position=self.head)
        await self.policy.catch_up()
        self.assertEqual(self.db.execute('SELECT event_id FROM tavern_system_outbox').fetchall(),[('$recent',)])
        self.assertEqual(self.db.execute('SELECT position FROM tavern_system_cursor').fetchone()[0],self.head)

    async def test_recovery_filters_recent_rejections_and_outliers_inside_window(self):
        await self.policy.initialize()
        self.add('$expired',position=101); self.db.execute('UPDATE events SET origin_server_ts=1 WHERE event_id=?',('$expired',))
        self.add('$rejected',position=102); self.db.execute('INSERT INTO rejections VALUES(?,?)',('$rejected','forbidden'))
        self.add('$outlier',position=103); self.db.execute('UPDATE events SET outlier=1 WHERE event_id=?',('$outlier',))
        self.add('$allowed',position=104)
        await self.policy.catch_up()
        self.assertEqual(self.db.execute('SELECT event_id FROM tavern_system_outbox').fetchall(),[('$allowed',)])

    async def test_current_native_and_custom_authority_cas_and_redaction_are_enforced(self):
        proposed=event(SYSTEM_MESSAGES,settings(**{'io.tavern.previous_event':'$config'}))
        self.assertTrue(await self.policy.check(proposed,self.parent))
        proposed.content['io.tavern.previous_event']=None
        self.assertFalse(await self.policy.check(proposed,self.parent))
        proposed.content['io.tavern.previous_event']='$config'
        self.parent[('m.room.power_levels','')].content['events']={SYSTEM_MESSAGES:101}
        self.assertFalse(await self.policy.check(proposed,self.parent))
        self.parent[('m.room.power_levels','')].content['events']={}
        self.parent[(model.POLICY,'')]=event(model.POLICY,{'version':999})
        self.assertFalse(await self.policy.check(proposed,self.parent))
        self.events['$config']=self.parent[(SYSTEM_MESSAGES,'')]
        self.assertFalse(await self.policy.check(event('m.room.redaction',{'redacts':'$config'}),self.parent))

    async def test_revocation_during_destination_wait_rejects_setting(self):
        async def read(room):
            if room==ROOM:
                self.parent[('m.room.member',OWNER)].content={'membership':'leave'}
                return self.child
            return self.parent
        self.api.get_room_state=read
        self.assertFalse(await self.policy.check(event(SYSTEM_MESSAGES,settings(**{'io.tavern.previous_event':'$config'})),self.parent))

    def test_settings_schema_is_strict(self):
        self.assertTrue(valid_settings(settings()))
        for changes in ({'enabled':1},{'version':True},{'joins':False,'leaves':False},{'channelId':'!x\nsecret'},{'hookId':'../secret'},{'extra':True}):
            self.assertFalse(valid_settings(settings(**changes)),changes)
