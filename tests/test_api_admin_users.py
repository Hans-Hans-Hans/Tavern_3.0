import asyncio
import time
import unittest
from urllib.parse import unquote, urlsplit, parse_qs

from api.server import APIError, COOKIE
from api.security import totp_setup, totp
from tests import test_api as fixture


class AdminUserTests(unittest.IsolatedAsyncioTestCase):
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login
    asyncTearDown = fixture.AccountAPITests.asyncTearDown

    async def asyncSetUp(self):
        await fixture.AccountAPITests.asyncSetUp(self)
        native = self.service.matrix
        self.inventory_calls = []
        self.before_update = None
        async def matrix(method, path, body=None, token=None, expected=True):
            decoded = unquote(urlsplit(path).path)
            query = parse_qs(urlsplit(path).query)
            if decoded == '/_synapse/admin/v3/users':
                self.inventory_calls.append(path)
                rows = [{'name': key, 'admin': bool(value.get('admin')), 'deactivated': bool(value.get('deactivated')), 'locked': bool(value.get('locked')), 'displayname': key, 'creation_ts': 1700000000000} for key, value in sorted(self.users.items())]
                if 'admins' in query: rows = [row for row in rows if row['admin'] == (query['admins'][0] == 'true')]
                if 'deactivated' in query: rows = [row for row in rows if row['deactivated'] == (query['deactivated'][0] == 'true')]
                start = int(query.get('from', ['0'])[0]); result = {'users': rows[start:start + 50], 'total': len(rows)}
                if start + 50 < len(rows): result['next_token'] = str(start + 50)
                return result
            if decoded.startswith('/_synapse/admin/v2/users/'):
                target, _, action = decoded.removeprefix('/_synapse/admin/v2/users/').partition('/')
                if target not in self.users: raise APIError(404, 'No account')
                if action == 'devices': return {'devices': [{'device_id': device} for user, device in self.tokens.values() if user == target and device]}
                if action == 'delete_devices':
                    self.tokens = {key: value for key, value in self.tokens.items() if value[0] != target or value[1] not in body['devices']}
                    return {}
                if not action:
                    if method == 'PUT':
                        if self.before_update: await self.before_update(target, body)
                        self.users[target].update(body)
                    result = {'name': target, 'creation_ts': 1700000000, **self.users[target]}
                    return result if expected else (200, result)
            if decoded.endswith('/joined_rooms') and decoded.startswith('/_synapse/admin/'):
                target = decoded.removeprefix('/_synapse/admin/v1/users/').removesuffix('/joined_rooms')
                return {'joined_rooms': [room for room, value in self.rooms.items() if value['members'].get(target) == 'join']}
            if decoded.startswith('/_synapse/admin/v1/suspend/'):
                self.users[decoded.rsplit('/', 1)[-1]]['suspended'] = body['suspend']; return {}
            if decoded.startswith('/_synapse/admin/v1/deactivate/'):
                self.users[decoded.rsplit('/', 1)[-1]]['deactivated'] = True; return {}
            return await native(method, path, body, token, expected)
        self.service.matrix = matrix

    async def action(self, cookie, operation, target='@alice:test', **extra):
        return await self.request('POST', '/api/admin/users/' + target + '/actions', {'action': operation, 'confirmation': target, 'password': 'Correct password!', **extra}, cookie)

    async def test_details_and_bounded_filtering_never_expose_secrets_or_false_total(self):
        owner, _, _ = await self.login('owner'); alice, _, _ = await self.login()
        self.service.store.db.execute("UPDATE accounts SET email='alice@example.com',verified=1,totp=? WHERE user_id='@alice:test'", (self.service.store.seal('top-secret-seed'),))
        for index in range(70): self.users['@a%03d:test' % index] = {'password': 'never-expose', 'admin': False}
        response = await self.request('GET', '/api/admin/users?mfa=enabled', cookie=owner)
        value = await response.json(); self.assertEqual(value['users'], []); self.assertEqual(value['next_token'], '50'); self.assertIsNone(value['total']); self.assertEqual(len(self.inventory_calls), 1)
        response = await self.request('GET', '/api/admin/users/@alice:test', cookie=alice); self.assertEqual(response.status, 403)
        response = await self.request('GET', '/api/admin/users/@alice:test', cookie=owner)
        value = await response.json(); self.assertEqual(value['security']['email'], 'alice@example.com'); self.assertEqual(value['security']['mfaMethods'], ['totp', 'recovery']); self.assertIsNone(value['storage']['usedBytes'])
        for secret in ('Correct password!', 'top-secret-seed', 'real-secret-token', alice): self.assertNotIn(secret, str(value))

    async def test_self_service_and_invalid_update_paths_are_protected(self):
        owner, _, _ = await self.login('owner')
        response = await self.request('PUT', '/api/admin/users/@owner:test', {'locked': True, 'confirmation': '@owner:test'}, owner); self.assertEqual(response.status, 400)
        response = await self.action(owner, 'deactivate', '@owner:test'); self.assertEqual(response.status, 400)
        response = await self.request('POST', '/api/account/deactivate', {'password': 'Correct password!', 'confirmation': '@owner:test'}, owner); self.assertEqual(response.status, 400)
        self.service.store.set('service_account', {'userId': '@service:test'})
        response = await self.action(owner, 'reset_mfa', '@service:test'); self.assertEqual(response.status, 400)
        response = await self.request('PUT', '/api/admin/users/@new:test', {'displayname': 'New'}, owner); self.assertEqual(response.status, 404); self.assertNotIn('@new:test', self.users)

    async def test_native_suspended_administrator_cannot_disable_last_active_peer(self):
        owner, _, _ = await self.login('owner')
        self.users['@alice:test']['admin'] = True
        self.users['@owner:test']['suspended'] = True
        response = await self.action(owner, 'deactivate'); self.assertEqual(response.status, 403)
        response = await self.request('PUT', '/api/admin/users/@alice:test', {'admin': False, 'confirmation': '@alice:test'}, owner)
        self.assertEqual(response.status, 403); self.assertTrue(self.users['@alice:test']['admin'])

    async def test_concurrent_admin_demotions_leave_an_active_administrator(self):
        self.users['@second:test'] = {'password': 'Correct password!', 'admin': True}
        owner, _, _ = await self.login('owner'); second, _, _ = await self.login('second')
        entered, release = asyncio.Event(), asyncio.Event()
        async def pause(target, body):
            if target == '@second:test': entered.set(); await release.wait()
        self.before_update = pause
        first = asyncio.create_task(self.request('PUT', '/api/admin/users/@second:test', {'admin': False, 'confirmation': '@second:test'}, owner))
        await asyncio.wait_for(entered.wait(), 1)
        other = asyncio.create_task(self.request('PUT', '/api/admin/users/@owner:test', {'admin': False, 'confirmation': '@owner:test'}, second))
        await asyncio.sleep(0); release.set()
        self.assertEqual((await first).status, 200); self.assertEqual((await other).status, 403)
        self.assertTrue(self.users['@owner:test']['admin']); self.assertFalse(self.users['@second:test']['admin'])

    async def test_forced_password_change_keeps_mfa_and_restricts_every_other_route(self):
        owner, _, _ = await self.login('owner'); await self.login()
        seed, _ = totp_setup('alice', 'Tavern')
        self.service.store.db.execute("UPDATE accounts SET totp=? WHERE user_id='@alice:test'", (self.service.store.seal(seed),))
        response = await self.action(owner, 'require_password_change'); self.assertEqual(response.status, 200)
        response = await self.request('POST', '/api/auth/login', {'username': 'alice', 'password': 'Correct password!'})
        value = await response.json(); self.assertTrue(value['mfaRequired'])
        response = await self.request('POST', '/api/auth/mfa', {'challengeId': value['challengeId'], 'method': 'totp', 'code': totp(seed, int(time.time()) // 30)})
        self.assertEqual(response.status, 200); self.assertTrue((await response.json())['passwordChangeRequired']); cookie = response.cookies[COOKIE].value
        for path in ('/api/matrix/_matrix/client/v3/sync', '/api/social', '/api/admin/users', '/api/account/export'):
            response = await self.request('GET', path, cookie=cookie); self.assertEqual(response.status, 403); self.assertEqual((await response.json())['errcode'], 'PASSWORD_CHANGE_REQUIRED')
        body = {'currentPassword': 'Correct password!', 'newPassword': 'Different correct password!', 'confirmation': 'Different correct password!', 'logoutOtherDevices': False}
        response = await self.request('POST', '/api/account/password', body, cookie); self.assertEqual(response.status, 400)
        codes = self.service.new_recovery_codes('@alice:test')
        response = await self.request('POST', '/api/account/password', {**body, 'method': 'recovery', 'code': codes[0]}, cookie); self.assertEqual(response.status, 200, await response.text())
        self.assertFalse(self.service.store.account('@alice:test')['password_change_required'])
        response = await self.request('GET', '/api/matrix/_matrix/client/v3/sync', cookie=cookie); self.assertEqual(response.status, 200)
        password_call = [call for call in self.upstream_calls if call[1].endswith('/account/password')][-1]
        self.assertTrue(password_call[2]['logout_devices'])

    async def test_mfa_reset_needs_operator_credentials_revokes_devices_and_requires_change(self):
        owner, _, _ = await self.login('owner'); alice, _, _ = await self.login()
        self.service.store.db.execute("UPDATE accounts SET totp=? WHERE user_id='@alice:test'", (self.service.store.seal('seed'),)); self.service.new_recovery_codes('@alice:test')
        response = await self.action(owner, 'reset_mfa', password='wrong'); self.assertEqual(response.status, 403); self.assertIsNotNone(self.service.store.account('@alice:test')['totp'])
        response = await self.action(owner, 'reset_mfa'); self.assertEqual(response.status, 200, await response.text())
        account = self.service.store.account('@alice:test'); self.assertIsNone(account['totp']); self.assertTrue(account['password_change_required'])
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM recovery_codes').fetchone()[0], 0)
        response = await self.request('GET', '/api/auth/session', cookie=alice); self.assertEqual(response.status, 401)

    async def test_operator_mfa_is_required_for_admin_recovery_actions(self):
        owner, _, _ = await self.login('owner'); await self.login()
        self.service.store.db.execute("UPDATE accounts SET totp=? WHERE user_id='@owner:test'", (self.service.store.seal('seed'),))
        response = await self.action(owner, 'reset_mfa'); self.assertEqual(response.status, 400); self.assertEqual((await response.json())['errcode'], 'MFA_REQUIRED')
        codes = self.service.new_recovery_codes('@owner:test')
        response = await self.action(owner, 'reset_mfa', method='recovery', code=codes[0]); self.assertEqual(response.status, 200)

    async def test_native_non_admin_status_forbidden_does_not_disable_own_deactivation(self):
        await self.login('owner')
        cookie, _, _ = await self.login(); native = self.service.matrix
        async def matrix(method, path, body=None, token=None, expected=True):
            if path.endswith('/admin'): return 403, {'errcode': 'M_FORBIDDEN'}
            return await native(method, path, body, token, expected)
        self.service.matrix = matrix
        response = await self.request('POST', '/api/account/deactivate', {'password': 'Correct password!', 'confirmation': '@alice:test'}, cookie)
        self.assertEqual(response.status, 200, await response.text())

    async def test_suspend_enable_and_per_user_quota_enforce_native_and_gateway_changes(self):
        owner, _, _ = await self.login('owner'); await self.login()
        response = await self.action(owner, 'suspend'); self.assertEqual(response.status, 200); self.assertTrue(self.users['@alice:test']['suspended'])
        response = await self.request('POST', '/api/auth/login', {'username': 'alice', 'password': 'Correct password!'}); self.assertEqual(response.status, 403)
        response = await self.action(owner, 'enable'); self.assertEqual(response.status, 200); self.assertFalse(self.users['@alice:test']['suspended'])
        await self.login()
        response = await self.action(owner, 'set_quota', quotaBytes=2048); self.assertEqual(response.status, 200)
        self.service.store.db.execute("INSERT INTO upload_usage VALUES('*',0)")
        with self.assertRaises(APIError) as caught: self.service.uploads.reserve('@alice:test', 2049)
        self.assertEqual(caught.exception.code, 'STORAGE_QUOTA_EXCEEDED')
        response = await self.action(owner, 'set_quota', quotaBytes=None); self.assertEqual(response.status, 200)
        reservation = self.service.uploads.reserve('@alice:test', 2049); self.assertTrue(reservation)


if __name__ == '__main__': unittest.main()
