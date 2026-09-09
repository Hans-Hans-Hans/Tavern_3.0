"""Portable real HTTP/AES/SQLite queue checks and source-level send-order checks.

The runtime method tests compile the actual Bridge methods without importing the
Linux fcntl/nio bootstrap. Their Matrix transport and response classes are fakes;
they do not claim to exercise matrix-nio encryption or a live homeserver.
"""
import ast
import asyncio
import copy
import hashlib
import hmac
import json
from pathlib import Path
import sqlite3
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from integrations import system_messages as queue
from integrations.configuration import load_configuration
from integrations.protocol import authenticate, transaction


IDENTITY = '12345678-1234-4234-8234-123456789abc'
BOT, ALICE, ROOM = '@bot:test', '@alice:test', '!room:test'


def source():
    return {'version': 1, 'eventId': '$joined', 'serverId': '!space:test', 'configEventId': '$config',
            'channelId': ROOM, 'hookId': 'system', 'userId': ALICE, 'change': 'join',
            'occurredAt': int(time.time() * 1000), 'audience': [BOT, ALICE]}


def permission():
    return {'roomId': ROOM, 'hookId': 'system', 'audience': [BOT, ALICE], 'botUserId': BOT,
            'botDeviceId': 'BOT', 'configurationRevision': 'a' * 64}


class SystemQueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.folder = Path(self.temporary.name)
        self.key = bytes.fromhex('ab' * 32)
        (self.folder / 'system-messages.hmac').write_text(self.key.hex())
        self.bridge = SimpleNamespace(db=sqlite3.connect(self.folder / 'queue.db'), queue_key=bytes.fromhex('cd' * 32),
            matrix_lock=asyncio.Lock(), reload_configuration=Mock(), send_system_notice=AsyncMock(return_value='$sent'),
            config={'system_messages': {'api_url': queue.API_ORIGIN, 'secret_file': '/config/system-messages.hmac'}},
            client=SimpleNamespace(user_id=BOT, device_id='BOT'))
        self.deliveries = queue.SystemDeliveries(self.bridge, self.folder)
        self.deliveries.authorize = AsyncMock(return_value=permission())
        app = web.Application(client_max_size=queue.MAX_BODY)
        app.router.add_post('/internal/system-deliveries', lambda request: self.deliveries.enqueue(request))
        self.http = TestClient(TestServer(app)); await self.http.start_server()
        self.data = {'id': IDENTITY, 'expiresAt': int(time.time() * 1000) + 600000, 'source': source(), 'authorization': permission()}

    async def asyncTearDown(self):
        await self.http.close(); await self.deliveries.close()
        self.bridge.db.close(); self.temporary.cleanup()

    def row(self):
        return self.bridge.db.execute('SELECT id,payload,nonce,tag,expires,attempts FROM system_deliveries WHERE id=?', (IDENTITY,)).fetchone()

    async def post(self, data=None, raw=None, signature=None):
        raw = raw if raw is not None else json.dumps(self.data if data is None else data).encode()
        stamp = str(int(time.time()))
        return await self.http.post('/internal/system-deliveries', data=raw, headers={'Content-Type': 'application/json',
            'X-Tavern-System-Timestamp': stamp, 'X-Tavern-System-Signature': signature or queue.signature(self.key, 'system-delivery', raw, stamp)})

    async def test_real_http_signature_schema_and_encrypted_queue_survive_reopen_with_tombstones(self):
        rejected = await self.post(signature='f' * 64); self.assertEqual(rejected.status, 403)
        raw, stamp = json.dumps(self.data).encode(), str(int(time.time()))
        wrong_purpose = await self.post(raw=raw, signature=queue.signature(self.key, 'system-authorize', raw, stamp))
        self.assertEqual(wrong_purpose.status, 403)
        accepted = await self.post(); self.assertEqual(accepted.status, 202)
        self.assertEqual((await self.post()).status, 200)
        payload = self.row()[1]
        self.assertNotIn(ALICE.encode(), payload); self.assertNotIn(b'joined', payload)
        self.bridge.db.close(); self.bridge.db = sqlite3.connect(self.folder / 'queue.db')
        self.deliveries = queue.SystemDeliveries(self.bridge, self.folder)
        self.deliveries.authorize = AsyncMock(return_value=permission())
        await self.deliveries.deliver_one(self.row())
        self.bridge.send_system_notice.assert_awaited_once()
        self.assertEqual(self.bridge.db.execute('SELECT status,payload,nonce,tag,event_id FROM system_deliveries').fetchone(), ('sent', None, None, None, '$sent'))
        repeated = await self.post(); self.assertEqual(repeated.status, 200)
        self.assertEqual(await repeated.json(), {'status': 'sent', 'eventId': '$sent'})
        self.assertEqual(self.bridge.db.execute('SELECT count(*) FROM system_deliveries').fetchone()[0], 1)

    async def test_duplicate_json_bad_scope_and_expired_ingress_are_rejected_before_queueing(self):
        raw = json.dumps(self.data).encode().replace(b'"id":', b'"id":"duplicate", "id":', 1)
        self.assertEqual((await self.post(raw=raw)).status, 400)
        for change in ['expiry', 'audience', 'identity']:
            data = copy.deepcopy(self.data)
            if change == 'expiry': data['expiresAt'] = int(time.time() * 1000) - 1
            elif change == 'audience': data['authorization']['audience'].append('@new:test')
            else: data['authorization']['botUserId'] = '@other:test'
            self.assertEqual((await self.post(data)).status, 400)
        self.assertEqual(self.bridge.db.execute('SELECT count(*) FROM system_deliveries').fetchone()[0], 0)

    async def test_expiry_and_disabled_service_scrub_pending_payload_and_never_send(self):
        await self.post(); row = self.row()
        with patch.object(queue.time, 'time', return_value=self.data['expiresAt'] / 1000 + 1):
            await self.deliveries.deliver_one(row)
        self.deliveries.authorize.assert_not_awaited(); self.bridge.send_system_notice.assert_not_awaited()
        self.assertEqual(self.bridge.db.execute('SELECT status,payload,nonce,tag FROM system_deliveries').fetchone(), ('cancelled', None, None, None))
        self.bridge.config = {}
        self.assertEqual((await self.post()).status, 404)
        self.bridge.config = {'system_messages': {'api_url': queue.API_ORIGIN, 'secret_file': '/config/system-messages.hmac'}}
        await self.deliveries.deliver_one(row)
        self.bridge.send_system_notice.assert_not_awaited()

    async def test_selected_row_cancelled_while_waiting_for_matrix_lock_cannot_resurrect(self):
        await self.post(); row = self.row()
        await self.bridge.matrix_lock.acquire()
        waiting = asyncio.create_task(self.deliveries.deliver_one(row))
        try:
            await asyncio.sleep(0); self.deliveries.finish(IDENTITY, 'cancelled')
        finally:
            self.bridge.matrix_lock.release(); await waiting
        self.deliveries.authorize.assert_not_awaited(); self.bridge.send_system_notice.assert_not_awaited()

    async def test_authoritative_cancellation_and_bot_identity_change_prevent_delivery(self):
        await self.post()
        changed = permission(); changed['botDeviceId'] = 'REPLACEMENT'
        self.deliveries.authorize.return_value = changed
        await self.deliveries.deliver_one(self.row())
        self.assertEqual(self.bridge.db.execute('SELECT status,attempts FROM system_deliveries').fetchone(), ('pending', 1))
        self.bridge.send_system_notice.assert_not_awaited()
        self.deliveries.authorize.return_value = None
        await self.deliveries.deliver_one(self.row())
        self.assertEqual(self.bridge.db.execute('SELECT status,payload FROM system_deliveries').fetchone(), ('cancelled', None))

    async def test_corrupt_ciphertext_and_unknown_send_result_retry_without_claiming_success(self):
        await self.post(); row = self.row()
        corrupt = (row[0], bytes([row[1][0] ^ 1]) + row[1][1:], *row[2:])
        await self.deliveries.deliver_one(corrupt)
        self.deliveries.authorize.assert_not_awaited(); self.bridge.send_system_notice.assert_not_awaited()
        self.bridge.send_system_notice.side_effect = RuntimeError('Transport outcome unknown')
        await self.deliveries.deliver_one(self.row())
        status, attempts, next_attempt = self.bridge.db.execute('SELECT status,attempts,next_attempt FROM system_deliveries').fetchone()
        self.assertEqual((status, attempts), ('pending', 2)); self.assertGreater(next_attempt, time.time() * 1000)
        self.assertIsNotNone(self.row()[1])

    async def test_invalid_event_confirmation_preserves_ciphertext_and_retries_same_delivery(self):
        await self.post()
        for event_id in ['', 'not-an-event', '$', '$bad space', True]:
            self.bridge.send_system_notice.return_value = event_id
            await self.deliveries.deliver_one(self.row())
            self.assertEqual(self.bridge.db.execute('SELECT status,event_id FROM system_deliveries').fetchone(), ('pending', ''))
            self.assertIsNotNone(self.row()[1])
        self.assertEqual({call.args[0] for call in self.bridge.send_system_notice.await_args_list}, {IDENTITY})
        self.bridge.send_system_notice.return_value = '$confirmed'
        await self.deliveries.deliver_one(self.row())
        self.assertEqual(self.bridge.db.execute('SELECT status,payload,event_id FROM system_deliveries').fetchone(), ('sent', None, '$confirmed'))

    async def test_hmac_configuration_is_fixed_and_included_in_real_configuration_revision(self):
        (self.folder / 'hook.hmac').write_text('x' * 48)
        config = {'homeserver': 'http://synapse:8008', 'hooks': {'system': {'room_id': ROOM,
            'allowed_users': [BOT, ALICE], 'secret_file': '/config/hook.hmac'}}}
        path = self.folder / 'bot.json'; path.write_text(json.dumps(config))
        _, _, old = load_configuration(path)
        config.update(self.bridge.config); path.write_text(json.dumps(config))
        _, _, new = load_configuration(path); self.assertNotEqual(old, new)
        config['system_messages']['api_url'] = 'https://other.example'; path.write_text(json.dumps(config))
        with self.assertRaises(ValueError): load_configuration(path)


class FakeErrorResponse: pass
class FakeRoomSendResponse:
    def __init__(self, event_id='$sent'): self.event_id = event_id


def runtime_methods():
    path = Path(__file__).resolve().parents[1] / 'integrations/server.py'
    tree = ast.parse(path.read_text())
    bridge = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Bridge')
    methods = [node for node in bridge.body if isinstance(node, ast.AsyncFunctionDef) and node.name in ('recipients', 'send_system_notice')]
    namespace = {'hmac': hmac, 'hashlib': hashlib, 'ErrorResponse': FakeErrorResponse,
        'RoomSendResponse': FakeRoomSendResponse, 'notice_content': queue.notice_content, 'system_identifier': queue.identifier}
    exec(compile(ast.Module(body=methods, type_ignores=[]), str(path), 'exec'), namespace)
    return namespace


class SystemSendMethodTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        methods = runtime_methods()
        self.bridge = SimpleNamespace(hooks={'system': {'room_id': ROOM, 'allowed_users': [BOT, ALICE]}},
            pins={ALICE: {'PHONE': 'A' * 43}}, configuration='a' * 64,
            sync_task=SimpleNamespace(done=lambda: False), reload_configuration=Mock())
        self.device = SimpleNamespace(id='PHONE', ed25519='A' * 43)
        self.client = SimpleNamespace(user_id=BOT, device_id='BOT', should_query_keys=False,
            rooms={ROOM: SimpleNamespace(encrypted=True, users={BOT: object(), ALICE: object()})},
            joined_members=AsyncMock(return_value=object()), device_store=SimpleNamespace(active_user_devices=lambda user: [self.device] if user == ALICE else []),
            invalidate_outbound_session=Mock(), verify_device=Mock(), unverify_device=Mock(),
            share_group_session=AsyncMock(return_value=SimpleNamespace(users_shared_with={(ALICE, 'PHONE')})),
            room_send=AsyncMock(return_value=FakeRoomSendResponse()))
        self.bridge.client = self.client
        self.bridge.recipients = methods['recipients'].__get__(self.bridge)
        self.send = methods['send_system_notice'].__get__(self.bridge)
        self.authorize = AsyncMock(return_value=permission())

    async def test_system_transaction_is_stable_and_disjoint_from_every_public_hook_namespace(self):
        self.assertEqual(await self.send(IDENTITY, source(), permission(), self.authorize), '$sent')
        first = self.client.room_send.await_args
        self.assertEqual(first.args, (ROOM, 'm.room.message', queue.notice_content(source())))
        self.assertFalse(first.kwargs['ignore_unverified_devices'])
        self.assertRegex(first.kwargs['tx_id'], r'^tavern-system-[0-9a-f]{64}$')
        for hook in ['system', 'tavern-system', 'system-notice', 'a' * 64]:
            self.assertNotEqual(first.kwargs['tx_id'], transaction(hook, IDENTITY))
        # The formerly colliding public hook is valid and accepts that exact UUID.
        raw, stamp, key = b'{"text":"Public delivery"}', str(int(time.time())), b'x' * 32
        signed = b'v1\nsystem\n' + stamp.encode() + b'\n' + IDENTITY.encode() + b'\n' + raw
        signature = 'sha256=' + hmac.new(key, signed, hashlib.sha256).hexdigest()
        self.assertEqual(authenticate('system', stamp, IDENTITY, signature, raw, key), 'Public delivery')
        await self.send(IDENTITY, source(), permission(), self.authorize)
        self.assertEqual(self.client.room_send.await_args.kwargs['tx_id'], first.kwargs['tx_id'])

    async def test_plaintext_room_unapproved_user_unpinned_device_and_partial_share_never_send(self):
        for scenario in ['plaintext', 'outsider', 'fingerprint', 'share']:
            with self.subTest(scenario=scenario):
                self.client.rooms[ROOM].encrypted = scenario != 'plaintext'
                self.client.rooms[ROOM].users = {BOT: object(), ALICE: object(), **({'@other:test': object()} if scenario == 'outsider' else {})}
                self.device.ed25519 = ('B' if scenario == 'fingerprint' else 'A') * 43
                self.client.share_group_session.return_value = SimpleNamespace(users_shared_with=set() if scenario == 'share' else {(ALICE, 'PHONE')})
                with self.assertRaises(RuntimeError): await self.send(IDENTITY, source(), permission(), self.authorize)
                self.client.room_send.assert_not_awaited()

    async def test_audience_or_authorization_change_before_or_after_key_share_stops_send(self):
        self.authorize.return_value = {**permission(), 'audience': [BOT]}
        with self.assertRaisesRegex(RuntimeError, 'authorization changed'): await self.send(IDENTITY, source(), permission(), self.authorize)
        self.client.share_group_session.assert_not_awaited()
        for result in [None, {**permission(), 'audience': [BOT]}]:
            self.authorize.side_effect = [permission(), result]
            if result is None: self.assertIsNone(await self.send(IDENTITY, source(), permission(), self.authorize))
            else:
                with self.assertRaisesRegex(RuntimeError, 'authorization changed'): await self.send(IDENTITY, source(), permission(), self.authorize)
            self.client.room_send.assert_not_awaited(); self.client.invalidate_outbound_session.assert_called_with(ROOM)

    async def test_configuration_changes_during_recipient_or_key_share_await_stop_send(self):
        self.bridge.reload_configuration.side_effect = lambda: setattr(self.bridge, 'configuration', 'b' * 64)
        with self.assertRaisesRegex(RuntimeError, 'approvals changed'): await self.send(IDENTITY, source(), permission(), self.authorize)
        self.client.share_group_session.assert_not_awaited()
        self.bridge.configuration = 'a' * 64
        def recheck():
            if self.client.share_group_session.await_count: self.bridge.configuration = 'b' * 64
        self.bridge.reload_configuration.side_effect = recheck
        with self.assertRaisesRegex(RuntimeError, 'approvals changed'): await self.send(IDENTITY, source(), permission(), self.authorize)
        self.client.room_send.assert_not_awaited()

    async def test_encryption_failure_and_unknown_native_send_are_not_reported_as_sent(self):
        self.client.share_group_session.return_value = FakeErrorResponse()
        with self.assertRaisesRegex(RuntimeError, 'encryption keys'): await self.send(IDENTITY, source(), permission(), self.authorize)
        self.client.room_send.assert_not_awaited()
        self.client.share_group_session.return_value = SimpleNamespace(users_shared_with={(ALICE, 'PHONE')})
        self.client.room_send.return_value = FakeErrorResponse()
        with self.assertRaisesRegex(RuntimeError, 'did not confirm'): await self.send(IDENTITY, source(), permission(), self.authorize)
        for event_id in ['', 'not-an-event', '$', '$bad space']:
            self.client.room_send.return_value = FakeRoomSendResponse(event_id)
            with self.assertRaisesRegex(RuntimeError, 'did not confirm'): await self.send(IDENTITY, source(), permission(), self.authorize)
