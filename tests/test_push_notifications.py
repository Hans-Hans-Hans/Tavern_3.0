import asyncio
import json
import os
import time
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from api.server import COOKIE, create_app
from api.push_notifications import APP_ID, GATEWAY_PATH, PushNotifications
from api.push_transport import encode64, subscription_hash
from tests import test_api as fixture


def browser_subscription(endpoint='https://push.example.org/device/opaque-private-endpoint'):
    key = ec.generate_private_key(ec.SECP256R1())
    return {'endpoint': endpoint, 'expirationTime': None, 'keys': {
        'p256dh': encode64(key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)),
        'auth': encode64(b'0123456789abcdef')}}, key


class PushTests(unittest.IsolatedAsyncioTestCase):
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login
    asyncTearDown = fixture.AccountAPITests.asyncTearDown

    async def asyncSetUp(self):
        self.environment = patch.dict(os.environ, {'WEB_PUSH_ENABLED': 'true'})
        self.environment.start(); self.addCleanup(self.environment.stop)
        self.worker = patch.object(PushNotifications, 'run', AsyncMock())
        self.worker.start(); self.addCleanup(self.worker.stop)
        await fixture.AccountAPITests.asyncSetUp(self)
        self.owner, _, _ = await self.login('owner')
        self.alice, _, _ = await self.login()
        self.push = self.service.push
        self.pushers, self.account_data, self.events = {}, {}, {}
        self.room_state = []
        self.subscription, self.recipient_key = browser_subscription()
        self.native_hook = None
        async def upstream(request, payload):
            native = self.tokens.get(request.headers.get('Authorization', '').removeprefix('Bearer '))
            if not native: return None
            user, _ = native
            if self.native_hook:
                response = await self.native_hook(request, payload, user)
                if response is not None: return response
            path = request.path
            if path == '/_matrix/client/v3/pushers/set':
                key = (user, payload['app_id'], payload['pushkey'])
                if payload['kind'] is None:
                    self.pushers.pop(key, None)
                else:
                    self.pushers[key] = payload
                return web.json_response({})
            if path == '/_matrix/client/v3/pushers':
                return web.json_response({'pushers': [p for (owner, _, _), p in self.pushers.items() if owner == user]})
            if '/account_data/' in path:
                key = path.split('/account_data/', 1)[1]
                value = self.account_data.get((user, key))
                return web.json_response(value if value is not None else {}, status=200 if value is not None else 404)
            if path == '/_matrix/client/v3/rooms/!room:test/state':
                return web.json_response(self.room_state)
            if '/event/' in path:
                event = self.events.get(path.split('/event/', 1)[1])
                return web.json_response(event or {}, status=200 if event else 404)
        self.upstream_response = upstream

    async def register(self, cookie=None, value=None):
        response = await self.request('POST', '/api/push/subscription', {'consent': True, 'subscription': value or self.subscription}, cookie or self.alice)
        self.assertEqual(response.status, 201, await response.text())
        return await response.json()

    def envelope(self, event='$new', **extra):
        pusher = next(p for (user, _, _), p in self.pushers.items() if user == '@alice:test')
        return {'notification': {'room_id': '!room:test', 'event_id': event, 'devices': [{
            'app_id': APP_ID, 'pushkey': pusher['pushkey'], 'data': {'format': 'event_id_only'}}], **extra}}

    async def notify(self, event='$new'):
        self.events[event] = {'event_id': event, 'room_id': '!room:test', 'sender': '@owner:test', 'type': 'm.room.encrypted',
                              'origin_server_ts': int(time.time() * 1000), 'content': {'ciphertext': 'never-store-encrypted-event-body'}}
        response = await self.request('POST', GATEWAY_PATH, self.envelope(event), origin=None)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())['rejected'], [])

    async def deliver(self):
        with patch('api.push_notifications.send_push', AsyncMock(return_value=(201, 0))) as send:
            await self.push.process_once()
            return send

    async def test_opt_in_owner_device_csrf_and_fixed_native_registration(self):
        response = await self.request('POST', '/api/push/subscription', {'consent': True, 'subscription': self.subscription})
        self.assertEqual(response.status, 401)
        for body in ({'subscription': self.subscription}, {'consent': False, 'subscription': self.subscription}, {'consent': True, 'subscription': self.subscription, 'userId': '@owner:test'}):
            self.assertEqual((await self.request('POST', '/api/push/subscription', body, self.alice)).status, 400)
        self.assertEqual((await self.request('POST', '/api/push/subscription', {'consent': True, 'subscription': self.subscription}, self.alice, origin='https://evil.example')).status, 403)
        result = await self.register()
        self.assertEqual(set(result), {'id', 'generation', 'expiresAt', 'subscriptionHash'})
        self.assertEqual(result['subscriptionHash'], subscription_hash(self.subscription))
        row = self.service.store.db.execute('SELECT * FROM push_subscriptions').fetchone()
        self.assertEqual(row['state'], 'active')
        serialized = json.dumps(dict(row))
        for secret in (self.subscription['endpoint'], self.subscription['keys']['auth'], self.subscription['keys']['p256dh']):
            self.assertNotIn(secret, serialized)
        pusher = next(iter(self.pushers.values()))
        self.assertEqual(pusher['data'], {'format': 'event_id_only', 'url': self.config.public_url + GATEWAY_PATH})
        self.assertFalse(pusher['append']); self.assertEqual(pusher['app_id'], APP_ID)
        config = await self.request('GET', '/api/push/config', cookie=self.alice)
        value = await config.json()
        self.assertEqual(value['subscription'], result)
        self.assertEqual(len(value['publicKey']), 87)
        self.assertNotIn(pusher['pushkey'], json.dumps(value))
        # Explicit consent rotates even if an earlier server DELETE failed.
        renewed = await self.register()
        self.assertNotEqual(renewed['generation'], result['generation'])
        self.assertEqual(len(self.pushers), 1)

    async def test_unknown_capability_bad_payloads_and_counts_cannot_enqueue(self):
        await self.register()
        unknown = self.envelope(); unknown['notification']['devices'][0]['pushkey'] = 'A' * 43
        response = await self.request('POST', GATEWAY_PATH, unknown, origin=None)
        self.assertEqual((await response.json())['rejected'], ['A' * 43])
        for change in ({'content': {'body': 'do not accept text'}}, {'event_id': 'invalid'}, {'event_id': '$bad\n'}, {'devices': []}, {'counts': {'unread': True}}, {'prio': 'urgent'}):
            envelope = self.envelope(); envelope['notification'].update(change)
            self.assertEqual((await self.request('POST', GATEWAY_PATH, envelope, origin=None)).status, 400)
        envelope = self.envelope(); envelope['notification'].pop('event_id'); envelope['notification'].pop('room_id')
        envelope['notification']['counts'] = {'unread': 7}
        self.assertEqual((await self.request('POST', GATEWAY_PATH, envelope, origin=None)).status, 200)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 0)
        envelope = self.envelope(); envelope['notification']['devices'].append({'pushkey': 'invalid'})
        self.assertEqual((await self.request('POST', GATEWAY_PATH, envelope, origin=None)).status, 400)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 0)

    async def test_generic_delivery_and_ticket_check_do_not_export_native_content(self):
        registration = await self.register()
        await self.notify(); await self.notify()
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 1)
        send = await self.deliver(); send.assert_awaited_once()
        payload = send.await_args.args[3]
        self.assertEqual(set(payload), {'v', 'kind', 'generation', 'ticket', 'expiresAt'})
        self.assertEqual(payload['generation'], registration['generation'])
        for secret in ('@owner:test', '!room:test', '$new', 'never-store-encrypted-event-body'):
            self.assertNotIn(secret, json.dumps(payload))
        response = await self.request('POST', '/api/push/check', {'ticket': payload['ticket'], 'generation': payload['generation']})
        self.assertEqual(await response.json(), {'show': True})
        self.assertEqual((await self.request('POST', '/api/push/check', {'ticket': payload['ticket'], 'generation': payload['generation']}, origin='https://evil.example')).status, 403)
        self.assertEqual(await (await self.request('POST', '/api/push/check', {'ticket': payload['ticket'], 'generation': 'wrong'})).json(), {'show': False})
        await self.notify(); self.assertEqual((await self.deliver()).await_count, 0)

    async def test_current_mute_dnd_ignored_and_native_account_membership_gate_delivery(self):
        await self.register()
        cases = [
            ('nothing', {'global': {'mode': 'nothing'}}, None),
            ('temporary', {'global': {'mutedUntil': int(time.time() * 1000) + 60000}}, None),
            ('permanent', {'rooms': {'!room:test': {'mutedUntil': -1}}}, None),
            ('dnd', {}, {'mode': 'dnd'}),
            ('ignored', {}, None), ('left', {}, None), ('native_suspended', {}, None),
        ]
        for name, prefs, presence in cases:
            with self.subTest(name=name):
                self.account_data.clear()
                self.account_data[('@alice:test', 'io.tavern.notification_preferences')] = prefs
                if presence: self.account_data[('@alice:test', 'io.tavern.presence')] = presence
                if name == 'ignored': self.account_data[('@alice:test', 'm.ignored_user_list')] = {'ignored_users': {'@owner:test': {}}}
                self.rooms['!room:test']['members']['@alice:test'] = 'leave' if name == 'left' else 'join'
                self.users['@alice:test']['suspended'] = name == 'native_suspended'
                await self.notify('$' + name)
                self.assertEqual((await self.deliver()).await_count, 0)

    async def test_server_defaults_require_reciprocal_parent_and_channel_override_applies(self):
        await self.register()
        self.room_state = [{'type': 'm.space.parent', 'state_key': '!space:test', 'content': {'canonical': True, 'via': ['test']}}]
        reciprocal = True
        async def parent(request, payload, user):
            if '/rooms/!space:test/state/m.space.child/' in request.path:
                return web.json_response({'via': ['test']} if reciprocal else {})
            if request.path.endswith('/state/io.tavern.notification.defaults'):
                return web.json_response({'version': 1, 'mode': 'nothing'})
        self.native_hook = parent
        await self.notify('$muted'); self.assertEqual((await self.deliver()).await_count, 0)
        reciprocal = False
        await self.notify('$unrelated'); self.assertEqual((await self.deliver()).await_count, 1)
        reciprocal = True
        self.account_data[('@alice:test', 'io.tavern.notification_preferences')] = {'rooms': {'!room:test': {'mode': 'all'}}}
        await self.notify('$override'); self.assertEqual((await self.deliver()).await_count, 1)
        self.room_state.append({'type': 'm.space.parent', 'state_key': '!other:test', 'content': {'canonical': True, 'via': ['test']}})
        async def ambiguous(request, payload, user):
            if '/state/m.space.child/' in request.path: return web.json_response({'via': ['test']})
            return await parent(request, payload, user)
        self.native_hook = ambiguous
        await self.notify('$ambiguous-parent'); self.assertEqual((await self.deliver()).await_count, 0)

    async def test_logout_cascade_rejects_old_gateway_and_already_delivered_ticket(self):
        await self.register(); await self.notify()
        envelope = self.envelope()
        payload = (await self.deliver()).await_args.args[3]
        self.assertEqual((await self.request('POST', '/api/auth/logout', {}, self.alice)).status, 200)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM push_subscriptions').fetchone()[0], 0)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0], 0)
        response = await self.request('POST', GATEWAY_PATH, envelope, origin=None)
        self.assertEqual((await response.json())['rejected'], [envelope['notification']['devices'][0]['pushkey']])
        self.assertEqual(await (await self.request('POST', '/api/push/check', {'ticket': payload['ticket'], 'generation': payload['generation']})).json(), {'show': False})

    async def test_a_b_a_never_reuses_generation_and_other_session_cannot_unsubscribe(self):
        first = await self.register()
        response = await self.request('DELETE', '/api/push/subscription', {'id': first['id'], 'generation': first['generation']}, self.owner)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM push_subscriptions').fetchone()[0], 1)
        self.assertEqual((await self.request('POST', '/api/push/subscription', {'consent': True, 'subscription': self.subscription}, self.owner)).status, 409)
        await self.request('POST', '/api/auth/logout', {}, self.alice)
        second = await self.register(self.owner)
        await self.request('DELETE', '/api/push/subscription', {'id': second['id'], 'generation': second['generation']}, self.owner)
        self.alice, _, _ = await self.login()
        third = await self.register()
        self.assertEqual(len({first['generation'], second['generation'], third['generation']}), 3)

    async def test_native_registration_success_must_be_confirmed_and_survives_lost_response(self):
        async def broken(request, payload, user):
            if request.path == '/_matrix/client/v3/pushers/set' and payload['kind'] == 'http':
                self.pushers[(user, payload['app_id'], payload['pushkey'])] = payload
                return web.Response(text='<html>not a native response</html>', content_type='text/html')
        self.native_hook = broken
        result = await self.request('POST', '/api/push/subscription', {'consent': True, 'subscription': self.subscription}, self.alice)
        self.assertEqual(result.status, 502, await result.text())
        row = self.service.store.db.execute('SELECT * FROM push_subscriptions').fetchone()
        self.assertEqual(row['state'], 'pending')
        self.native_hook = None
        await self.push.process_once()
        config = await self.request('GET', '/api/push/config', cookie=self.alice)
        self.assertEqual((await config.json())['subscription']['generation'], row['generation'])

    async def test_provider_retry_cap_and_gone_subscription_cleanup(self):
        await self.register(); await self.notify()
        with patch('api.push_notifications.send_push', AsyncMock(return_value=(503, 17))) as send:
            for attempt in range(4):
                await self.push.process_once()
                self.service.store.db.execute('UPDATE push_jobs SET next_attempt=0')
            self.assertEqual(send.await_count, 4)
            self.assertEqual(self.service.store.db.execute('SELECT state FROM push_jobs').fetchone()[0], 'suppressed')
        await self.notify('$gone')
        with patch('api.push_notifications.send_push', AsyncMock(return_value=(410, 0))):
            await self.push.process_once()
        self.assertFalse(self.service.store.db.execute('SELECT 1 FROM push_jobs').fetchone())
        self.assertFalse(self.service.store.db.execute('SELECT 1 FROM push_subscriptions').fetchone())

    async def test_session_deleted_during_native_authority_wait_never_sends_or_recreates_queue(self):
        await self.register(); await self.notify()
        entered, release = asyncio.Event(), asyncio.Event()
        async def blocked(request, payload, user):
            if request.path.endswith('/state'):
                entered.set(); await release.wait()
        self.native_hook = blocked
        with patch('api.push_notifications.send_push', AsyncMock(return_value=(201, 0))) as send:
            running = asyncio.create_task(self.push.process_once())
            await asyncio.wait_for(entered.wait(), 2)
            self.service.deactivations.begin('@alice:test', False)
            release.set(); await running
            send.assert_not_awaited()
        self.assertFalse(self.service.store.db.execute('SELECT 1 FROM push_jobs').fetchone())
        self.assertFalse(self.service.store.db.execute('SELECT 1 FROM push_subscriptions').fetchone())

    async def test_malformed_native_authorization_and_wrong_event_identity_fail_closed(self):
        await self.register(); await self.notify()
        async def broken(request, payload, user):
            if '/_synapse/admin/v2/users/' in request.path:
                return web.Response(text='<html>maintenance</html>')
        self.native_hook = broken
        self.assertEqual((await self.deliver()).await_count, 0)
        self.native_hook = None
        await self.notify('$wrong'); self.events['$wrong']['room_id'] = '!other:test'
        self.assertEqual((await self.deliver()).await_count, 0)

    async def test_permissions_changed_during_parent_state_wait_are_refetched(self):
        await self.register()
        for change in ('left', 'dnd', 'nothing', 'suspended'):
            self.account_data.clear()
            self.rooms['!room:test']['members']['@alice:test'] = 'join'
            self.users['@alice:test']['suspended'] = False
            async def changed(request, payload, user):
                if request.path.endswith('/state'):
                    if change == 'left': self.rooms['!room:test']['members']['@alice:test'] = 'leave'
                    if change == 'dnd': self.account_data[('@alice:test', 'io.tavern.presence')] = {'mode': 'dnd'}
                    if change == 'nothing': self.account_data[('@alice:test', 'io.tavern.notification_preferences')] = {'global': {'mode': 'nothing'}}
                    if change == 'suspended': self.users['@alice:test']['suspended'] = True
            self.native_hook = changed
            await self.notify('$late-' + change)
            self.assertEqual((await self.deliver()).await_count, 0)

    async def test_provider_boundary_refresh_and_delayed_ticket_honor_new_choices(self):
        await self.register(); await self.notify()
        async def delayed_provider(subscription, pem, subject, payload, ttl, authorize, reauthorize):
            self.account_data[('@alice:test', 'io.tavern.presence')] = {'mode': 'dnd'}
            await reauthorize()
            self.fail('Provider headers must not be written after the fresh DND check.')
        with patch('api.push_notifications.send_push', delayed_provider):
            await self.push.process_once()
        self.assertEqual(self.service.store.db.execute('SELECT state FROM push_jobs').fetchone()[0], 'suppressed')
        self.account_data.clear()
        await self.notify('$allowed')
        payload = (await self.deliver()).await_args.args[3]
        self.account_data[('@alice:test', 'io.tavern.notification_preferences')] = {'rooms': {'!room:test': {'mode': 'nothing'}}}
        response = await self.request('POST', '/api/push/check', {'ticket': payload['ticket'], 'generation': payload['generation']})
        self.assertEqual(await response.json(), {'show': False})

    async def test_maintenance_suppresses_alerts_without_revoking_subscription(self):
        await self.register(); await self.notify()
        self.service.store.set('policy', {'maintenance': {'enabled': True}})
        self.assertEqual((await self.deliver()).await_count, 0)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM push_subscriptions').fetchone()[0], 1)

    async def test_logout_during_native_registration_cannot_restore_binding(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def held(request, payload, user):
            if request.path.endswith('/pushers/set') and payload['kind'] == 'http':
                entered.set(); await release.wait()
        self.native_hook = held
        registering = asyncio.create_task(self.request('POST', '/api/push/subscription', {'consent': True, 'subscription': self.subscription}, self.alice))
        await asyncio.wait_for(entered.wait(), 2)
        self.assertEqual((await self.request('POST', '/api/auth/logout', {}, self.alice)).status, 200)
        release.set()
        response = await registering
        self.assertEqual(response.status, 401, await response.text())
        self.assertFalse(self.service.store.db.execute('SELECT 1 FROM push_subscriptions').fetchone())
        self.assertFalse(self.service.store.db.execute('SELECT 1 FROM push_jobs').fetchone())

    async def test_invalid_enable_config_fails_startup(self):
        with patch.dict(os.environ, {'WEB_PUSH_ENABLED': 'ture'}), self.assertRaisesRegex(ValueError, 'WEB_PUSH_ENABLED'):
            PushNotifications(self.service)

    async def test_credential_change_requires_new_generation_even_with_same_session(self):
        first = await self.register(); await self.notify()
        self.service.store.db.execute('UPDATE accounts SET credential_epoch=? WHERE user_id=?', (time.time(), '@alice:test'))
        second = await self.register()
        self.assertNotEqual(first['generation'], second['generation'])
        self.assertFalse(self.service.store.db.execute('SELECT 1 FROM push_jobs').fetchone())

    async def test_foreground_lease_is_bounded_per_tab_and_expiry_restores_delivery(self):
        registration = await self.register()
        sequence = 0
        async def lease(client, active=True, cookie=None, **extra):
            nonlocal sequence
            sequence += 1
            return await self.request('POST', '/api/push/foreground', {'generation': registration['generation'], 'clientId': client * 32, 'sequence': sequence, 'active': active, **extra}, cookie or self.alice)
        response = await lease('a')
        self.assertEqual(response.status, 200, await response.text())
        self.assertTrue(time.time() * 1000 < (await response.json())['expiresAt'] <= (time.time() + 35) * 1000)
        self.assertEqual((await lease('b')).status, 200)
        self.assertEqual((await lease('a', False)).status, 200)
        self.assertEqual((await lease('a', sequence=1)).status, 200)
        row = self.service.store.db.execute('SELECT active,sequence FROM push_foreground WHERE client_id=?', ('a' * 32,)).fetchone()
        self.assertEqual(tuple(row), (0, 3))
        await self.notify('$open-other-tab')
        self.assertEqual((await self.deliver()).await_count, 0)
        # A tab cannot renew another account's generation or extend the TTL.
        self.assertEqual((await lease('b', cookie=self.owner)).status, 409)
        self.assertEqual((await lease('b', expiresAt=9999999999999)).status, 400)
        self.assertEqual((await lease('b', active='true')).status, 400)
        self.service.store.db.execute('UPDATE push_foreground SET expires=0')
        await self.notify('$after-freeze')
        self.assertEqual((await self.deliver()).await_count, 1)
        await lease('a')
        await self.request('POST', '/api/auth/logout', {}, self.alice)
        self.assertFalse(self.service.store.db.execute('SELECT 1 FROM push_foreground').fetchone())

    async def test_foreground_lease_started_during_provider_wait_prevents_send(self):
        registration = await self.register(); await self.notify()
        async def delayed_provider(subscription, pem, subject, payload, ttl, authorize, reauthorize):
            response = await self.request('POST', '/api/push/foreground', {'generation': registration['generation'], 'clientId': 'a' * 32, 'sequence': 1, 'active': True}, self.alice)
            self.assertEqual(response.status, 200)
            await reauthorize()
            self.fail('A foreground lease should prevent this provider send.')
        with patch('api.push_notifications.send_push', delayed_provider):
            await self.push.process_once()
        self.assertEqual(self.service.store.db.execute('SELECT state FROM push_jobs').fetchone()[0], 'suppressed')

    async def test_worker_binding_requires_current_cookie_device_generation_and_origin(self):
        first = await self.register()
        alice_device = self.service.store.db.execute('SELECT device_id FROM sessions WHERE cookie_hash=?', (self.service.store.digest(self.alice),)).fetchone()[0]
        headers = {'Cookie': COOKIE + '=' + self.alice, 'Origin': self.config.public_url, 'X-Tavern-Device': alice_device}
        async def bind(generation=first['generation'], custom=None):
            return await self.client.post('/api/push/bind', json={'generation': generation}, headers=headers if custom is None else custom)
        response = await bind()
        self.assertEqual(await response.json(), {'valid': True, 'generation': first['generation'], 'expiresAt': first['expiresAt']})
        self.assertEqual((await bind(custom={k: v for k, v in headers.items() if k != 'X-Tavern-Device'})).status, 401)
        self.assertEqual((await bind(custom={**headers, 'X-Tavern-Device': 'old-device'})).status, 401)
        self.assertEqual((await bind(custom={**headers, 'Origin': 'https://evil.example'})).status, 403)
        self.assertEqual((await bind(custom={**headers, 'Cookie': COOKIE + '=' + self.owner})).status, 401)
        second = await self.register()
        self.assertEqual(await (await bind()).json(), {'valid': False})
        self.assertEqual(await (await bind(second['generation'])).json(), {'valid': True, 'generation': second['generation'], 'expiresAt': second['expiresAt']})
        self.service.deactivations.begin('@alice:test', False)
        self.assertEqual((await bind(second['generation'])).status, 401)

    async def test_streamed_worker_bind_cannot_authorize_after_deactivation(self):
        registration = await self.register()
        row = self.service.store.db.execute('SELECT device_id FROM sessions WHERE cookie_hash=?', (self.service.store.digest(self.alice),)).fetchone()
        entered, release = asyncio.Event(), asyncio.Event()
        async def body():
            yield b'{"generation":"'
            entered.set(); await release.wait()
            yield registration['generation'].encode() + b'"}'
        pending = asyncio.create_task(self.client.post('/api/push/bind', data=body(), headers={
            'Cookie': COOKIE + '=' + self.alice, 'Origin': self.config.public_url, 'X-Tavern-Device': row['device_id'], 'Content-Type': 'application/json'}))
        await asyncio.wait_for(entered.wait(), 2)
        self.service.deactivations.begin('@alice:test', False)
        release.set()
        response = await asyncio.wait_for(pending, 2)
        self.assertEqual(response.status, 401, await response.text())
        self.assertFalse(self.service.store.db.execute('SELECT 1 FROM push_subscriptions').fetchone())

    async def test_delayed_worker_bind_never_restores_old_cookie_after_new_login(self):
        registration = await self.register()
        row = self.service.store.db.execute('SELECT * FROM sessions WHERE cookie_hash=?', (self.service.store.digest(self.alice),)).fetchone()
        self.service.store.db.execute('UPDATE sessions SET rotated=? WHERE id=?', (time.time() - 901, row['id']))
        entered, release = asyncio.Event(), asyncio.Event()
        authenticate = self.service.authenticate
        def authenticated(request):
            result = authenticate(request)
            if request.path == '/api/push/bind': entered.set()
            return result
        self.service.authenticate = authenticated
        async def body():
            yield b'{"generation":"'
            await release.wait()
            yield registration['generation'].encode() + b'"}'
        pending = asyncio.create_task(self.client.post('/api/push/bind', data=body(), headers={
            'Cookie': COOKIE + '=' + self.alice, 'Origin': self.config.public_url, 'X-Tavern-Device': row['device_id'], 'Content-Type': 'application/json'}))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            login = await self.request('POST', '/api/auth/login', {'username': 'owner', 'password': 'Correct password!'}, self.alice)
            self.assertEqual(login.status, 200, await login.text())
        finally:
            release.set()
        response = await asyncio.wait_for(pending, 2)
        self.assertEqual(response.status, 401)
        self.assertNotIn('Set-Cookie', response.headers)
        self.assertNotIn(COOKIE, response.cookies)
        current = await self.request('GET', '/api/auth/session', cookie=login.cookies[COOKIE].value)
        self.assertEqual((await current.json())['userId'], '@owner:test')

    async def replacement_cookie(self, user):
        previous = await self.register(); await self.notify()
        other_subscription, _ = browser_subscription('https://push.example.org/unrelated-owner-device')
        unrelated = await self.register(self.owner, other_subscription)
        previous_session = self.service.store.db.execute('SELECT session_id FROM push_subscriptions WHERE generation=?', (previous['generation'],)).fetchone()[0]
        bad = await self.request('POST', '/api/auth/login', {'username': user, 'password': 'Wrong password!'}, self.alice)
        self.assertNotEqual(bad.status, 200)
        self.assertTrue(self.service.store.db.execute('SELECT 1 FROM push_subscriptions WHERE generation=?', (previous['generation'],)).fetchone())
        response = await self.request('POST', '/api/auth/login', {'username': user, 'password': 'Correct password!'}, self.alice)
        self.assertEqual(response.status, 200, await response.text())
        self.assertFalse(self.service.store.db.execute('SELECT 1 FROM push_subscriptions WHERE generation=?', (previous['generation'],)).fetchone())
        self.assertFalse(self.service.store.db.execute('SELECT 1 FROM push_jobs').fetchone())
        self.assertTrue(self.service.store.db.execute('SELECT 1 FROM sessions WHERE id=?', (previous_session,)).fetchone())
        self.assertLessEqual(self.service.store.db.execute('SELECT expires FROM sessions WHERE id=?', (previous_session,)).fetchone()[0], time.time())
        self.assertTrue(self.service.store.db.execute('SELECT 1 FROM push_subscriptions WHERE generation=?', (unrelated['generation'],)).fetchone())
        self.assertNotEqual(response.cookies[COOKIE].value, self.alice)

    async def test_login_new_account_revokes_only_prior_cookie_push_owner(self):
        await self.replacement_cookie('owner')

    async def test_login_new_device_same_account_revokes_only_prior_cookie_push_owner(self):
        await self.replacement_cookie('alice')

    async def test_restart_preserves_vapid_and_queued_delivery(self):
        first = await self.register(); await self.notify()
        public_key = self.push.public_key
        await self.client.close()
        self.app = create_app(self.config); self.service = self.app['service']; self.push = self.service.push
        self.client = TestClient(TestServer(self.app)); await self.client.start_server()
        self.assertEqual(self.push.public_key, public_key)
        self.assertEqual(self.service.store.db.execute('SELECT generation FROM push_subscriptions').fetchone()[0], first['generation'])
        self.assertEqual((await self.deliver()).await_count, 1)

    async def test_disabled_default_does_not_register_or_dispatch(self):
        self.push.enabled = False
        result = await self.request('GET', '/api/push/config', cookie=self.alice)
        self.assertEqual(await result.json(), {'enabled': False, 'publicKey': None, 'subscription': None})
        response = await self.request('POST', '/api/push/subscription', {'consent': True, 'subscription': self.subscription}, self.alice)
        self.assertEqual(response.status, 503)
        self.assertFalse(self.pushers)


if __name__ == '__main__':
    unittest.main()
