"""Actual Bridge handlers and encrypted queue; Matrix transport is isolated.

Linux CI installs the pinned integration requirements. Windows cannot import the
production bot's fcntl process lock, so these cases are explicitly skipped there.
The separate durable-store test exercises the real matrix-nio crypto store.
"""
import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations'))
try:
    from integrations import server
except ModuleNotFoundError as error:
    if error.name not in ('fcntl', 'nio', 'Crypto', 'olm'):
        raise
    server = None


@unittest.skipIf(server is None, 'Requires Linux and integrations/requirements.txt (run by CI)')
class BotRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.folder = Path(self.directory.name)
        (self.folder / 'hook.hmac').write_text('x' * 48)
        self.path = self.folder / 'bot.json'
        self.settings = {'homeserver': 'https://example.invalid', 'hooks': {'builds': {
            'room_id': '!room:test', 'allowed_users': ['@bot:test', '@alice:test'], 'secret_file': '/config/hook.hmac',
        }}, 'trusted_devices': {'@alice:test': {'PHONE': 'A' * 43}}}
        self.write_configuration()
        self.config_patch = patch.object(server, 'CONFIG', self.path)
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)
        self.bridge = server.Bridge.__new__(server.Bridge)
        self.bridge.config, self.bridge.secrets, self.bridge.configuration = server.load_configuration(self.path)
        self.bridge.config_stamp = None
        self.bridge.hooks = self.bridge.config['hooks']
        self.bridge.pins = self.bridge.config['trusted_devices']
        self.bridge.queue_key = bytes.fromhex('ab' * 32)
        self.bridge.matrix_lock = asyncio.Lock()
        self.bridge.rate = {}
        self.bridge.last_error = ''
        self.bridge.sync_task = Mock(done=lambda: False)
        self.bridge.db = sqlite3.connect(':memory:')
        self.bridge.db.executescript('''
            CREATE TABLE deliveries(hook TEXT,delivery TEXT,payload BLOB,nonce BLOB,tag BLOB,status TEXT,
                attempts INTEGER DEFAULT 0,next_attempt INTEGER,event_id TEXT,PRIMARY KEY(hook,delivery));
            CREATE TABLE hook_destinations(hook TEXT PRIMARY KEY,room TEXT NOT NULL);
        ''')
        server.persist_destinations(self.bridge.db, self.bridge.config)
        self.device = SimpleNamespace(id='PHONE', ed25519='A' * 43)
        response = object.__new__(server.RoomSendResponse)
        response.event_id = '$accepted:test'
        self.client = SimpleNamespace(
            user_id='@bot:test', device_id='BOT', should_query_keys=False,
            joined_members=AsyncMock(return_value=object()),
            rooms={'!room:test': SimpleNamespace(encrypted=True, users={'@bot:test': object(), '@alice:test': object()})},
            device_store=SimpleNamespace(active_user_devices=lambda user: [self.device] if user == '@alice:test' else []),
            invalidate_outbound_session=Mock(), verify_device=Mock(), unverify_device=Mock(),
            share_group_session=AsyncMock(return_value=SimpleNamespace(users_shared_with={('@alice:test', 'PHONE')})),
            room_send=AsyncMock(return_value=response),
        )
        self.bridge.client = self.client

    async def asyncTearDown(self):
        self.bridge.db.close()
        self.directory.cleanup()

    def write_configuration(self):
        temporary = self.folder / 'replacement.json'
        temporary.write_text(json.dumps(self.settings))
        os.replace(temporary, self.path)

    def request(self, delivery='12345678-1234-4234-8234-123456789abc'):
        raw = b'{"text":"Private build result"}'
        stamp = str(int(time.time()))
        signed = b'v1\nbuilds\n' + stamp.encode() + b'\n' + delivery.encode() + b'\n' + raw
        signature = 'sha256=' + hmac.new(b'x' * 48, signed, hashlib.sha256).hexdigest()
        return SimpleNamespace(content_type='application/json', read=AsyncMock(return_value=raw),
            match_info={'hook': 'builds'}, headers={'X-Tavern-Timestamp': stamp, 'X-Tavern-Delivery': delivery, 'X-Tavern-Signature': signature})

    def row(self):
        return self.bridge.db.execute('SELECT hook,delivery,payload,nonce,tag,attempts FROM deliveries ORDER BY rowid LIMIT 1').fetchone()

    async def test_legacy_signature_and_queue_deliver_current_metadata_without_sender_impersonation(self):
        self.assertEqual((await self.bridge.enqueue(self.request())).status, 202)
        self.assertNotIn(b'Private', self.row()[2])
        self.settings['hooks']['builds'].update(name='Nightly builds', avatar_url='mxc://media.example/build_icon', enabled=True,
                                               created_by='@owner:test', created_at=1789000000000)
        self.write_configuration()
        await self.bridge.deliver_one(self.row())
        self.client.verify_device.assert_called_once_with(self.device)
        self.client.share_group_session.assert_awaited_once_with('!room:test', ignore_unverified_devices=False)
        args, kwargs = self.client.room_send.await_args
        self.assertEqual(args, ('!room:test', 'm.room.message', {'msgtype': 'm.notice', 'body': 'Private build result',
            'io.tavern.webhook': {'id': 'builds', 'name': 'Nightly builds', 'avatar_url': 'mxc://media.example/build_icon'}}))
        self.assertFalse(kwargs['ignore_unverified_devices'])
        self.assertEqual(kwargs['tx_id'], server.transaction('builds', self.row()[1]))
        self.assertEqual(self.bridge.db.execute('SELECT status,payload,nonce,tag,event_id FROM deliveries').fetchone(),
                         ('sent', None, None, None, '$accepted:test'))
        repeat = await self.bridge.enqueue(self.request())
        self.assertEqual(json.loads(repeat.body)['status'], 'sent')
        self.assertEqual(self.bridge.db.execute('SELECT count(*) FROM deliveries').fetchone()[0], 1)

    async def test_disable_rejects_ingress_and_reenable_cannot_resurrect_row_waiting_on_lock(self):
        await self.bridge.enqueue(self.request())
        selected = self.row()
        await self.bridge.matrix_lock.acquire()
        waiting = asyncio.create_task(self.bridge.deliver_one(selected))
        try:
            await asyncio.sleep(0)
            self.settings['hooks']['builds']['enabled'] = False
            self.write_configuration()
            self.bridge.reload_configuration()
            self.assertEqual(self.bridge.db.execute('SELECT status,payload,nonce,tag FROM deliveries').fetchone(), ('cancelled', None, None, None))
        finally:
            self.bridge.matrix_lock.release()
            await waiting
        with self.assertRaises(server.web.HTTPNotFound):
            await self.bridge.enqueue(self.request('12345678-1234-4234-8234-123456789abd'))
        self.settings['hooks']['builds']['enabled'] = True
        self.write_configuration()
        self.bridge.reload_configuration()
        # Reproduce a worker holding the old selected row after an entire disable/enable cycle.
        await self.bridge.deliver_one(selected)
        response = await self.bridge.enqueue(self.request())
        self.assertEqual(json.loads(response.body)['status'], 'cancelled')
        self.client.joined_members.assert_not_awaited()
        self.client.share_group_session.assert_not_awaited()
        self.client.room_send.assert_not_awaited()
        self.assertEqual((await self.bridge.enqueue(self.request('12345678-1234-4234-8234-123456789abd'))).status, 202)

    async def test_name_avatar_and_enabled_never_bypass_membership_or_device_checks(self):
        self.settings['hooks']['builds'].update(name='Trusted system', avatar_url='mxc://media.example/icon', enabled=True)
        self.write_configuration()
        await self.bridge.enqueue(self.request())
        room = self.client.rooms['!room:test']
        room.users['@stranger:test'] = object()
        await self.bridge.deliver_one(self.row())
        self.client.room_send.assert_not_awaited()
        self.client.share_group_session.assert_not_awaited()
        del room.users['@stranger:test']
        self.device.ed25519 = 'B' * 43
        await self.bridge.deliver_one(self.row())
        self.client.unverify_device.assert_called_once_with(self.device)
        self.client.room_send.assert_not_awaited()
        self.client.share_group_session.assert_not_awaited()
        self.device.ed25519 = 'A' * 43
        await self.bridge.deliver_one(self.row())
        self.client.room_send.assert_awaited_once()

    async def test_plaintext_room_and_incomplete_key_share_keep_delivery_pending(self):
        await self.bridge.enqueue(self.request())
        self.client.rooms['!room:test'].encrypted = False
        await self.bridge.deliver_one(self.row())
        self.client.share_group_session.assert_not_awaited()
        self.client.room_send.assert_not_awaited()
        self.client.rooms['!room:test'].encrypted = True
        self.client.share_group_session.return_value = SimpleNamespace(users_shared_with=set())
        await self.bridge.deliver_one(self.row())
        self.client.room_send.assert_not_awaited()
        self.assertEqual(self.bridge.db.execute('SELECT status,attempts FROM deliveries').fetchone(), ('pending', 2))

    async def test_channel_change_fails_closed_and_cannot_reroute_existing_payload(self):
        await self.bridge.enqueue(self.request())
        self.settings['hooks']['builds']['room_id'] = '!other:test'
        self.write_configuration()
        with self.assertRaises(server.web.HTTPServiceUnavailable):
            await self.bridge.enqueue(self.request('12345678-1234-4234-8234-123456789abd'))
        await self.bridge.deliver_one(self.row())
        self.client.joined_members.assert_not_awaited()
        self.client.room_send.assert_not_awaited()
        self.assertEqual(self.bridge.db.execute('SELECT status FROM deliveries').fetchone()[0], 'pending')


if __name__ == '__main__':
    unittest.main()
