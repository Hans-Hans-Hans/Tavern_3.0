"""Real account HTTP/outbox and encrypted TLS worker delivery for contact alerts."""
import asyncio
import datetime
import json
import socket
import sqlite3
import ssl
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import aiohttp
import http_ece
from aiohttp import web
from aiohttp.test_utils import TestServer
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from api import social
from api.server import APIError, body_json
from api.push_notifications import PushNotifications
from api.push_transport import PublicResolver, GuardedResolver
from tests import test_push_notifications as fixture

WORKER_RUN = PushNotifications.run


class SocialPushTests(unittest.IsolatedAsyncioTestCase):
    request = fixture.PushTests.request
    login = fixture.PushTests.login
    asyncTearDown = fixture.PushTests.asyncTearDown
    register = fixture.PushTests.register
    deliver = fixture.PushTests.deliver

    async def asyncSetUp(self):
        self.social_helpers = patch.object(social, 'helpers', lambda: (APIError, body_json))
        self.social_helpers.start(); self.addCleanup(self.social_helpers.stop)
        await fixture.PushTests.asyncSetUp(self)
        self.db = self.service.store.db
        for user in self.users.values():
            user.update(locked=False, suspended=False, is_guest=False)
        self.policy_hook = None
        self.space = False
        async def native(request, payload, user):
            if self.policy_hook:
                response = await self.policy_hook(request, payload, user)
                if response is not None:
                    return response
            if request.path == '/_matrix/client/v3/account/whoami':
                identity = self.tokens[request.headers['Authorization'].removeprefix('Bearer ')]
                return web.json_response({'user_id': identity[0], 'device_id': identity[1]})
            if request.method == 'PUT' and '/account_data/' in request.path:
                self.account_data[(user, request.path.split('/account_data/', 1)[1])] = payload
                return web.json_response({})
            if request.path.endswith('/state/m.room.create'):
                return web.json_response({'type': 'm.space'} if self.space else {})
        self.native_hook = native

    async def friend_request(self):
        response = await self.request('POST', '/api/social/requests', {'target': '@alice:test'}, self.owner)
        self.assertEqual(response.status, 201, await response.text())
        return (await response.json())['requests'][0]['id']

    def reset_requests(self):
        self.db.execute('DELETE FROM social_requests')
        self.db.execute('DELETE FROM social_preferences')
        self.db.execute('DELETE FROM social_blocks')
        self.db.execute('DELETE FROM rate_limits')
        self.account_data.clear()

    async def ticket_check(self, payload):
        response = await self.request('POST', '/api/push/check', {key: payload[key] for key in ('generation', 'ticket')})
        self.assertEqual(response.status, 200)
        return (await response.json())['show']

    async def test_transaction_creates_only_real_request_jobs_for_current_opted_in_devices(self):
        registration = await self.register()
        identity = await self.friend_request()
        job = self.db.execute('SELECT * FROM push_jobs').fetchone()
        request = self.db.execute('SELECT * FROM social_requests').fetchone()
        self.assertEqual(job['kind'], 'social_request')
        self.assertEqual(job['social_request_id'], identity)
        self.assertIsNone(job['event_id']); self.assertIsNone(job['room_id'])
        self.assertEqual(job['created'], request['created'])
        self.assertLessEqual(job['expires'] - job['created'], 300)
        self.assertEqual(job['subscription_id'], registration['id'])
        self.push.enqueue_social_request(identity, '@alice:test', request['created'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 1)
        # A new generation never adopts the previous generation's queued work.
        replacement = await self.register()
        self.assertNotEqual(replacement['generation'], registration['generation'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 0)

    async def test_outbox_insert_failure_rolls_back_the_request(self):
        await self.register()
        self.db.execute("CREATE TRIGGER refuse_social_push BEFORE INSERT ON push_jobs WHEN NEW.kind='social_request' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END")
        response = await self.request('POST', '/api/social/requests', {'target': '@alice:test'}, self.owner)
        self.assertEqual(response.status, 500)
        self.assertEqual(self.db.execute('SELECT count(*) FROM social_requests').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 0)
        self.assertFalse(self.db.in_transaction)
        self.db.execute('DROP TRIGGER refuse_social_push')
        await self.friend_request()
        self.assertEqual(self.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 1)

    async def test_no_consent_disabled_expired_or_pending_subscriptions_do_not_enqueue(self):
        await self.friend_request()
        self.assertEqual(self.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 0)
        for state in ('disabled', 'expired', 'pending'):
            with self.subTest(state=state):
                self.reset_requests()
                await self.register()
                if state == 'disabled': self.push.enabled = False
                elif state == 'expired': self.db.execute('UPDATE push_subscriptions SET expires=?', (time.time() - 1,))
                else: self.db.execute("UPDATE push_subscriptions SET state='pending'")
                await self.friend_request()
                self.assertEqual(self.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 0)
                self.push.enabled = True
                self.db.execute('DELETE FROM push_subscriptions')

    async def test_pending_request_transitions_and_mutual_blocks_suppress_delivery_and_ticket(self):
        await self.register()
        for operation in ('accept', 'reject', 'cancel', 'block_sender', 'block_recipient', 'nobody'):
            with self.subTest(operation=operation):
                self.reset_requests()
                identity = await self.friend_request()
                send = await self.deliver(); send.assert_awaited_once()
                payload = send.await_args.args[3]
                self.assertTrue(await self.ticket_check(payload))
                if operation in ('accept', 'reject', 'cancel'):
                    response = await self.request('PATCH', '/api/social/requests/' + identity, {'operation': operation}, self.owner if operation == 'cancel' else self.alice)
                elif operation.startswith('block_'):
                    sender = operation == 'block_sender'
                    response = await self.request('PUT', '/api/social/blocks/' + ('@alice:test' if sender else '@owner:test'), {}, self.owner if sender else self.alice)
                else:
                    response = await self.request('PUT', '/api/social/privacy', {'requests': 'nobody'}, self.alice)
                self.assertEqual(response.status, 200, await response.text())
                self.assertFalse(await self.ticket_check(payload))
                self.db.execute("UPDATE push_jobs SET state='pending'")
                self.assertEqual((await self.deliver()).await_count, 0)

    async def test_preferences_presence_ignored_and_native_account_state_are_current(self):
        await self.register()
        cases = ('friend_optout', 'nothing', 'mute', 'temporary_mute', 'dnd', 'ignored',
                 'sender_suspended', 'recipient_suspended', 'sender_deactivated', 'recipient_locked',
                 'native_malformed', 'native_wrong_device', 'sender_access_blocked')
        for case in cases:
            with self.subTest(case=case):
                self.reset_requests(); self.policy_hook = None
                for user in self.users.values(): user.update(suspended=False, locked=False, deactivated=False)
                self.db.execute("UPDATE accounts SET access_blocked=''")
                await self.friend_request()
                prefs = {}
                if case == 'friend_optout': prefs = {'friendRequests': False}
                if case == 'nothing': prefs = {'mode': 'nothing'}
                if case == 'mute': prefs = {'mutedUntil': -1}
                if case == 'temporary_mute': prefs = {'mutedUntil': int(time.time() * 1000) + 60000}
                self.account_data[('@alice:test', 'io.tavern.notification_preferences')] = {'global': prefs}
                if case == 'dnd': self.account_data[('@alice:test', 'io.tavern.presence')] = {'mode': 'dnd'}
                if case == 'ignored': self.account_data[('@alice:test', 'm.ignored_user_list')] = {'ignored_users': {'@owner:test': {}}}
                if case == 'sender_suspended': self.users['@owner:test']['suspended'] = True
                if case == 'recipient_suspended': self.users['@alice:test']['suspended'] = True
                if case == 'sender_deactivated': self.users['@owner:test']['deactivated'] = True
                if case == 'recipient_locked': self.users['@alice:test']['locked'] = True
                if case == 'sender_access_blocked': self.db.execute("UPDATE accounts SET access_blocked=1 WHERE user_id='@owner:test'")
                if case == 'native_malformed': self.users['@owner:test']['suspended'] = 'false'
                if case == 'native_wrong_device':
                    async def mismatch(request, payload, user):
                        if request.path.endswith('/account/whoami'):
                            return web.json_response({'user_id': '@alice:test', 'device_id': 'OTHER'})
                    self.policy_hook = mismatch
                self.assertEqual((await self.deliver()).await_count, 0)

    async def test_direct_requests_allow_mentions_but_room_overrides_do_not_bypass_global_mute(self):
        await self.register()
        await self.friend_request()
        self.account_data[('@alice:test', 'io.tavern.notification_preferences')] = {'global': {'mode': 'mentions'}, 'rooms': {'!room:test': {'mode': 'nothing'}}}
        send = await self.deliver(); send.assert_awaited_once()
        self.account_data[('@alice:test', 'io.tavern.notification_preferences')] = {'global': {'mode': 'nothing'}, 'rooms': {'!room:test': {'mode': 'all'}}}
        self.assertFalse(await self.ticket_check(send.await_args.args[3]))

    async def test_shared_server_privacy_requires_current_membership_of_both_accounts(self):
        await self.register(); self.space = True
        self.assertEqual((await self.request('PUT', '/api/social/privacy', {'requests': 'shared_server'}, self.alice)).status, 200)
        await self.friend_request()
        send = await self.deliver(); send.assert_awaited_once()
        payload = send.await_args.args[3]
        self.assertTrue(await self.ticket_check(payload))
        self.rooms['!room:test']['members']['@owner:test'] = 'leave'
        self.assertFalse(await self.ticket_check(payload))
        self.rooms['!room:test']['members']['@owner:test'] = 'join'
        self.rooms['!room:test']['members']['@alice:test'] = 'leave'
        self.assertFalse(await self.ticket_check(payload))
        self.assertFalse(any('/_synapse/admin/v1/rooms' in path for _, path, _, _ in self.upstream_calls))

    async def test_shared_membership_lost_during_service_token_wait_is_rechecked(self):
        await self.register(); self.space = True
        await self.request('PUT', '/api/social/privacy', {'requests': 'shared_server'}, self.alice)
        await self.friend_request()
        original = self.service.service_token
        async def delayed():
            token = await original()
            self.rooms['!room:test']['members']['@owner:test'] = 'leave'
            return token
        with patch.object(self.service, 'service_token', delayed):
            self.assertEqual((await self.deliver()).await_count, 0)

    async def test_shared_membership_lost_during_final_account_reads_is_rechecked(self):
        await self.register(); self.space = True
        await self.request('PUT', '/api/social/privacy', {'requests': 'shared_server'}, self.alice)
        await self.friend_request()
        async def delayed(request, payload, user):
            if request.path.endswith('/account_data/io.tavern.presence'):
                await asyncio.sleep(0.02)
                self.rooms['!room:test']['members']['@owner:test'] = 'leave'
        self.policy_hook = delayed
        self.assertEqual((await self.deliver()).await_count, 0)

    async def test_explicit_malformed_notification_privacy_is_not_assumed_permissive(self):
        await self.register()
        for prefs in ({'friendRequests': 'false'}, {'friendRequests': 0}, {'mutedUntil': '-1'},
                      {'mutedUntil': True}, {'mutedUntil': -2}, {'mode': 'typo'}, {'mode': None}):
            with self.subTest(prefs=prefs):
                self.reset_requests()
                await self.friend_request()
                self.account_data[('@alice:test', 'io.tavern.notification_preferences')] = {'global': prefs}
                self.assertEqual((await self.deliver()).await_count, 0)

    async def test_native_outage_is_retryable_and_display_check_fails_closed(self):
        await self.register()
        await self.friend_request()
        async def unavailable(request, payload, user):
            if request.path.startswith('/_synapse/admin/v2/users/'):
                return web.json_response({'errcode': 'M_UNKNOWN'}, status=503)
        self.policy_hook = unavailable
        self.assertEqual((await self.deliver()).await_count, 0)
        job = self.db.execute('SELECT * FROM push_jobs').fetchone()
        self.assertEqual(job['state'], 'pending'); self.assertEqual(job['attempts'], 1)
        self.policy_hook = None
        self.db.execute('UPDATE push_jobs SET next_attempt=0')
        send = await self.deliver(); send.assert_awaited_once()
        self.policy_hook = unavailable
        self.assertFalse(await self.ticket_check(send.await_args.args[3]))

    async def test_pending_deactivation_and_request_deletion_invalidate_delivery(self):
        await self.register()
        identity = await self.friend_request()
        send = await self.deliver(); send.assert_awaited_once()
        payload = send.await_args.args[3]
        self.service.deactivations.begin('@owner:test', False)
        self.assertFalse(await self.ticket_check(payload))
        self.db.execute('DELETE FROM social_requests WHERE id=?', (identity,))
        self.assertEqual(self.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 0)

    async def test_queue_bound_keeps_contact_request_and_expiry_reclaims_capacity(self):
        registration = await self.register()
        now = time.time()
        for index in range(50):
            ticket = 'fixture-ticket-' + str(index)
            self.db.execute('INSERT INTO push_jobs(id,subscription_id,room_id,event_id,created,expires,ticket_hash,ticket) VALUES(?,?,?,?,?,?,?,?)',
                (str(index), registration['id'], '!room:test', '$event' + str(index), now, now - 1,
                 self.service.store.digest(ticket), self.service.store.seal(ticket)))
        await self.friend_request()
        self.assertEqual(self.db.execute("SELECT count(*) FROM push_jobs WHERE kind='social_request'").fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM social_requests').fetchone()[0], 1)
        await self.push.process_once()
        self.assertEqual(self.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 0)

    async def test_local_request_privacy_and_security_changes_during_native_await_are_rechecked(self):
        await self.register()
        for change in ('cancel', 'privacy', 'block', 'sender_credential'):
            with self.subTest(change=change):
                self.reset_requests()
                identity = await self.friend_request()
                changed = False
                async def delayed(request, payload, user):
                    nonlocal changed
                    if not changed and request.path.endswith('/account/whoami'):
                        changed = True
                        await asyncio.sleep(0)
                        if change == 'cancel': self.db.execute("UPDATE social_requests SET status='cancelled' WHERE id=?", (identity,))
                        if change == 'privacy': self.db.execute("INSERT INTO social_preferences VALUES('@alice:test','nobody')")
                        if change == 'block': self.db.execute("INSERT INTO social_blocks VALUES('@owner:test','@alice:test',?)", (time.time(),))
                        if change == 'sender_credential': self.db.execute("UPDATE accounts SET credential_epoch=credential_epoch+1 WHERE user_id='@owner:test'")
                self.policy_hook = delayed
                self.assertEqual((await self.deliver()).await_count, 0)
                self.assertTrue(changed)
                self.policy_hook = None

    async def test_provider_refresh_cancellation_and_native_dnd_prevent_send(self):
        await self.register()
        for change in ('cancel', 'dnd'):
            with self.subTest(change=change):
                self.reset_requests()
                identity = await self.friend_request()
                wrote = False
                async def provider(subscription, pem, subject, payload, ttl, authorize, refresh):
                    nonlocal wrote
                    if change == 'cancel': self.db.execute("UPDATE social_requests SET status='cancelled' WHERE id=?", (identity,))
                    else: self.account_data[('@alice:test', 'io.tavern.presence')] = {'mode': 'dnd'}
                    await refresh()
                    authorize()
                    wrote = True
                    return 201, 0
                with patch('api.push_notifications.send_push', provider):
                    await self.push.process_once()
                self.assertFalse(wrote)
                self.assertEqual(self.db.execute('SELECT state FROM push_jobs').fetchone()[0], 'suppressed')

    async def test_expiry_credential_epoch_and_native_logout_revoke_tickets(self):
        await self.register()
        await self.friend_request()
        send = await self.deliver(); payload = send.await_args.args[3]
        self.assertTrue(await self.ticket_check(payload))
        self.db.execute('UPDATE push_jobs SET expires=?', (time.time() - 1,))
        self.assertFalse(await self.ticket_check(payload))
        self.db.execute('UPDATE push_jobs SET expires=?', (time.time() + 60,))
        self.db.execute("UPDATE accounts SET credential_epoch=credential_epoch+1 WHERE user_id='@alice:test'")
        self.assertFalse(await self.ticket_check(payload))
        self.db.execute("UPDATE accounts SET credential_epoch=credential_epoch-1 WHERE user_id='@alice:test'")
        self.tokens = {key: value for key, value in self.tokens.items() if value[0] != '@alice:test'}
        self.assertFalse(await self.ticket_check(payload))

    async def test_matrix_schema_upgrade_preserves_old_ticket_and_strict_kinds(self):
        await self.register()
        await fixture.PushTests.notify(self)
        original = dict(self.db.execute('SELECT * FROM push_jobs').fetchone())
        self.db.executescript('''ALTER TABLE push_jobs RENAME TO upgraded_jobs;
            CREATE TABLE push_jobs(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
                room_id TEXT NOT NULL,event_id TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,
                next_attempt REAL NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',
                ticket_hash TEXT UNIQUE NOT NULL,ticket TEXT NOT NULL,UNIQUE(subscription_id,event_id));
            INSERT INTO push_jobs SELECT id,subscription_id,room_id,event_id,created,expires,next_attempt,attempts,state,ticket_hash,ticket FROM upgraded_jobs;
            DROP TABLE upgraded_jobs;''')
        self.push = PushNotifications(self.service)
        migrated = dict(self.db.execute('SELECT * FROM push_jobs').fetchone())
        self.assertEqual(migrated, original)
        send = await self.deliver(); send.assert_awaited_once()
        for statement in ("UPDATE push_jobs SET kind='social_request'", "UPDATE push_jobs SET kind='invented'"):
            with self.assertRaises(sqlite3.IntegrityError): self.db.execute(statement)
        self.db.execute('DELETE FROM push_subscriptions')
        self.assertEqual(self.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 0)

    envelope = fixture.PushTests.envelope

    async def tls_provider(self):
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'push.example.org')])
        now = datetime.datetime.now(datetime.timezone.utc)
        certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=1))
            .not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName('push.example.org')]), critical=False)
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).sign(key, hashes.SHA256()))
        cert_path, key_path = Path(self.directory.name) / 'push.pem', Path(self.directory.name) / 'push-key.pem'
        cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        server_ssl = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); server_ssl.load_cert_chain(cert_path, key_path)
        client_ssl = ssl.create_default_context(cafile=str(cert_path))
        received, requests = asyncio.Event(), []
        async def provider(request):
            requests.append((dict(request.headers), await request.read()))
            received.set()
            return web.Response(status=201)
        app = web.Application(); app.router.add_post('/{path:.*}', provider)
        server = TestServer(app); await server.start_server(ssl=server_ssl)
        self.addAsyncCleanup(server.close)
        async def resolve(resolver, host, port=0, family=socket.AF_UNSPEC):
            self.assertEqual(host, 'push.example.org'); self.assertEqual(port, 443)
            return [{'hostname': host, 'host': '127.0.0.1', 'port': server.port, 'family': socket.AF_INET, 'proto': socket.IPPROTO_TCP, 'flags': socket.AI_NUMERICHOST}]
        original = aiohttp.TCPConnector
        def connector(**kwargs):
            self.assertIsInstance(kwargs['resolver'], GuardedResolver)
            return original(**kwargs, ssl=client_ssl)
        return received, requests, resolve, connector

    async def test_closed_browser_runtime_worker_after_restart_delivers_real_encrypted_https_notice(self):
        registration = await self.register()
        identity = await self.friend_request()
        self.assertFalse(self.app['social_watchers'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM push_foreground').fetchone()[0], 0)
        job = dict(self.db.execute('SELECT * FROM push_jobs').fetchone())
        self.db.execute("UPDATE push_jobs SET state='sending'")
        public_key = self.push.public_key
        self.push = PushNotifications(self.service)
        self.assertEqual(self.push.public_key, public_key)
        self.assertEqual(self.db.execute('SELECT state FROM push_jobs').fetchone()[0], 'pending')
        received, requests, resolve, connector = await self.tls_provider()
        with patch.object(PublicResolver, 'resolve', resolve), patch('api.push_transport.aiohttp.TCPConnector', connector):
            task = asyncio.create_task(WORKER_RUN(self.push))
            try:
                await asyncio.wait_for(received.wait(), 4)
                for _ in range(100):
                    if self.db.execute('SELECT state FROM push_jobs').fetchone()[0] == 'sent': break
                    await asyncio.sleep(0.01)
                self.assertEqual(self.db.execute('SELECT state FROM push_jobs').fetchone()[0], 'sent')
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
        self.assertEqual(len(requests), 1)
        headers, ciphertext = requests[0]
        plaintext = http_ece.decrypt(ciphertext, private_key=self.recipient_key, auth_secret=b'0123456789abcdef', version='aes128gcm')
        payload = json.loads(plaintext)
        self.assertEqual(set(payload), {'v', 'kind', 'generation', 'ticket', 'expiresAt'})
        self.assertEqual(payload['kind'], 'activity')
        self.assertEqual(payload['generation'], registration['generation'])
        self.assertEqual(payload['ticket'], self.service.store.open(job['ticket']))
        self.assertNotIn(payload['ticket'].encode(), ciphertext)
        for private in (identity, '@owner:test', '@alice:test', '!room:test', 'Correct password!'):
            self.assertNotIn(private.encode(), plaintext)
        self.assertFalse({'Cookie', 'Referer'} & headers.keys())
        self.assertTrue(await self.ticket_check(payload))
        self.assertFalse(any('/event/' in path for _, path, _, _ in self.upstream_calls))
        await self.request('PATCH', '/api/social/requests/' + identity, {'operation': 'cancel'}, self.owner)
        self.assertFalse(await self.ticket_check(payload))


if __name__ == '__main__':
    unittest.main()
