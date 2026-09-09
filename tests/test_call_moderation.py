import base64
import hashlib
import hmac
import json
import unittest
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from api.call_moderation import CallModerator, CONFIRMATION, admin_token, room_alias, target_identities
from api.server import APIError


class CallModerationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.trace = []
        self.allowed, self.removed, self.fail_disconnect, self.late_device = True, False, False, False
        self.participants = [{'identity': '@member:test:A'}, {'identity': '@member:test:B'}, {'identity': '@other:test:C'}]
        self.events = [{'type': 'm.room.member', 'state_key': user, 'content': {'membership': 'join'}} for user in ('@mod:test', '@member:test', '@other:test')]
        self.events += [{'type': 'org.matrix.msc3401.call.member', 'sender': '@member:test', 'content': {'application': 'm.call', 'call_id': '', 'device_id': device}} for device in ('A', 'B')]
        def session(request):
            if request.headers.get('X-Test-Session') != 'yes':
                raise APIError(401, 'Sign in')
            return {'user_id': '@mod:test', 'token': 'sealed-session-token'}
        async def matrix(method, path, body=None, token=None):
            self.trace.append((method, path, body, token))
            if path.endswith('/kick'):
                if not self.allowed:
                    raise APIError(403, 'Role hierarchy forbids this kick')
                self.removed = True
                return {}
            if path.startswith('/_synapse/admin/'):
                return {'state': self.events}
            return {'algorithm': 'm.megolm.v1.aes-sha2'} if path.endswith('/m.room.encryption/') else {'membership': 'join'}
        async def service_token():
            return 'server-read-token'
        service = SimpleNamespace(require_session=session, store=SimpleNamespace(open=lambda token: 'caller-token', rate=lambda *args: None), matrix=matrix, service_token=service_token, audit=lambda *args: self.trace.append(('audit', args)))
        self.moderator = CallModerator(service)
        self.moderator.credentials = lambda: ('test-api-key', 'x' * 64)
        async def sfu(method, room, values=None):
            self.trace.append(('SFU', method, room, values))
            if method == 'ListParticipants':
                if self.removed and self.late_device:
                    return {'participants': [{'identity': '@member:test:JOINED_DURING_KICK'}]}
                return {'participants': self.participants}
            if self.fail_disconnect:
                raise APIError(502, 'SFU is unavailable')
            self.participants = [participant for participant in self.participants if participant['identity'] != values['identity']]
            return {}
        self.moderator.sfu = sfu
        @web.middleware
        async def errors(request, handler):
            try:
                return await handler(request)
            except APIError as error:
                return web.json_response({'error': error.message}, status=error.status)
        app = web.Application(middlewares=[errors])
        app.router.add_post('/remove', self.moderator.remove)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def request(self, **patch):
        return await self.client.post('/remove', headers={'X-Test-Session': 'yes'}, json={'roomId': '!room:test', 'userId': '@member:test', 'confirmation': CONFIRMATION, **patch})

    async def test_native_kick_precedes_removal_and_only_targets_authenticated_room_devices(self):
        response = await self.request()
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())['disconnectedDevices'], 2)
        kick = next(i for i, entry in enumerate(self.trace) if entry[0] == 'POST')
        removed = [(i, entry) for i, entry in enumerate(self.trace) if entry[:2] == ('SFU', 'RemoveParticipant')]
        self.assertTrue(all(i > kick for i, _ in removed))
        self.assertEqual([entry[3]['identity'] for _, entry in removed], ['@member:test:A', '@member:test:B'])
        self.assertTrue(all(entry[2] == room_alias('!room:test') for _, entry in removed))
        self.assertEqual(self.trace[kick][3], 'caller-token')

    async def test_matrix_denial_never_mutates_sfu(self):
        self.allowed = False
        self.assertEqual((await self.request()).status, 403)
        self.assertFalse(self.removed)
        self.assertFalse(any(entry[:2] == ('SFU', 'RemoveParticipant') for entry in self.trace))

    async def test_confirmation_authentication_and_self_removal_are_required(self):
        self.assertEqual((await self.client.post('/remove', json={})).status, 401)
        self.assertEqual((await self.request(confirmation='yes')).status, 400)
        self.assertEqual((await self.request(userId='@mod:test')).status, 400)
        self.assertEqual(self.trace, [])

    async def test_sfu_failure_reports_membership_removed_without_claiming_media_success(self):
        self.fail_disconnect = True
        response = await self.request()
        value = await response.json()
        self.assertEqual(response.status, 200)
        self.assertTrue(self.removed)
        self.assertTrue(value['membershipRemoved'])
        self.assertFalse(value['mediaDisconnectConfirmed'])
        self.assertEqual(value['disconnectedDevices'], 0)
        self.assertIn('did not confirm', value['message'])

    async def test_unknown_devices_or_modern_mapping_fail_before_membership_changes(self):
        self.participants.append({'identity': '@member:test:UNKNOWN'})
        self.assertEqual((await self.request()).status, 503)
        self.assertFalse(self.removed)
        self.participants = [{'identity': 'opaque-modern-hash'}]
        self.assertEqual((await self.request()).status, 503)
        self.assertFalse(self.removed)

    async def test_device_join_race_is_reported_as_unconfirmed_after_membership_removal(self):
        self.late_device = True
        response = await self.request()
        result = await response.json()
        self.assertEqual(response.status, 200)
        self.assertTrue(result['membershipRemoved'])
        self.assertFalse(result['mediaDisconnectConfirmed'])
        self.assertEqual(result['disconnectedDevices'], 2)


class ScopedIdentityTests(unittest.TestCase):
    def test_ambiguous_legacy_prefix_cannot_remove_another_members_devices(self):
        events = [{'type': 'm.room.member', 'state_key': '@member:test:8448', 'content': {'membership': 'join'}},
                  {'type': 'org.matrix.msc3401.call.member', 'sender': '@member:test', 'content': {'application': 'm.call', 'call_id': '', 'device_id': '8448:DEVICE'}}]
        with self.assertRaises(APIError):
            target_identities(events, [{'identity': '@member:test:8448:DEVICE'}], '@member:test')

    def test_admin_jwt_is_short_lived_signed_and_scoped_to_one_exact_room(self):
        token = admin_token('api-key', 'secret' * 10, room_alias('!room:test'), now=1000)
        header, payload, signature = token.split('.')
        data = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        self.assertEqual(data['exp'], 1060)
        self.assertEqual(data['video'], {'roomAdmin': True, 'room': room_alias('!room:test')})
        expected = hmac.new(('secret' * 10).encode(), (header + '.' + payload).encode(), hashlib.sha256).digest()
        self.assertEqual(base64.urlsafe_b64decode(signature + '=' * (-len(signature) % 4)), expected)
        self.assertNotEqual(room_alias('!room:test'), room_alias('!other:test'))


if __name__ == '__main__':
    unittest.main()
