from io import BytesIO
import time
import unittest

from PIL import Image, PngImagePlugin
from api.security import totp
from api.server import COOKIE
from tests import test_api as fixture


class InstanceAdminTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.AccountAPITests.asyncSetUp
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def policy(self, cookie, changes, password='Correct password!'):
        current = await (await self.request('GET', '/api/admin/security-policy', cookie=cookie)).json()
        return await self.request('PUT', '/api/admin/security-policy', {'revision': current['revision'], 'settings': {**current, **changes}, 'password': password}, cookie)

    async def upload(self, cookie, body, slot='icon'):
        return await self.client.post('/api/admin/branding/assets/' + slot, data=body, headers={'Cookie': COOKIE + '=' + cookie, 'Origin': fixture.ORIGIN, 'Content-Type': 'image/png'})

    async def test_branding_upload_is_admin_only_decodes_pixels_and_strips_original_payload(self):
        owner, _, _ = await self.login('owner'); alice, _, _ = await self.login()
        image = Image.new('RGB', (1024, 1024), 'green'); metadata = PngImagePlugin.PngInfo(); metadata.add_text('Secret-location', 'private GPS metadata')
        output = BytesIO(); image.save(output, format='PNG', pnginfo=metadata)
        raw = output.getvalue() + b'<script>untrusted payload</script>'
        response = await self.upload(alice, raw); self.assertEqual(response.status, 403)
        response = await self.upload(owner, b'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'); self.assertEqual(response.status, 400)
        response = await self.upload(owner, raw); self.assertEqual(response.status, 200)
        location = (await response.json())['url']
        response = await self.client.get(location); self.assertEqual(response.status, 200)
        encoded = await response.read(); self.assertNotIn(b'private GPS', encoded); self.assertNotIn(b'<script>', encoded)
        with Image.open(BytesIO(encoded)) as decoded: self.assertEqual(decoded.size, (512, 512)); self.assertFalse(decoded.info)
        response = await self.upload(owner, b'x' * (2 * 1024 * 1024 + 1)); self.assertEqual(response.status, 413)

    async def test_branding_rejects_external_images_and_stale_revisions(self):
        owner, _, _ = await self.login('owner')
        current = await (await self.request('GET', '/api/admin/branding', cookie=owner)).json()
        response = await self.request('PUT', '/api/admin/branding', {**current, 'name': 'My community', 'icon': 'https://elsewhere.example/private.svg'}, owner); self.assertEqual(response.status, 400)
        response = await self.request('PUT', '/api/admin/branding', {**current, 'name': 'My community'}, owner); self.assertEqual(response.status, 200)
        response = await self.request('PUT', '/api/admin/branding', {**current, 'name': 'Stale edit'}, owner); self.assertEqual(response.status, 409)
        self.assertEqual(self.service.store.get('instance')['name'], 'My community')
        response = await self.request('PUT', '/api/admin/settings', {'instance': {'name': 'Name', 'icon': 'data:image/svg+xml,<svg/>'}}, owner); self.assertEqual(response.status, 400)

    async def test_cleanup_is_confirmed_and_cannot_remove_published_images_or_other_files(self):
        owner, _, _ = await self.login('owner'); output = BytesIO(); Image.new('RGB', (16, 16), 'green').save(output, format='PNG')
        url = (await (await self.upload(owner, output.getvalue())).json())['url']
        current = await (await self.request('GET', '/api/admin/branding', cookie=owner)).json(); self.assertEqual(current['unusedAssets'], [url])
        response = await self.request('POST', '/api/admin/branding/cleanup', {'assets': [url]}, owner); self.assertEqual(response.status, 400)
        response = await self.request('POST', '/api/admin/branding/cleanup', {'assets': ['/api/branding/assets/../api.key'], 'confirmation': 'DELETE UNUSED'}, owner); self.assertEqual(response.status, 400)
        response = await self.request('PUT', '/api/admin/branding', {**current, 'icon': url}, owner); self.assertEqual(response.status, 200)
        current = await response.json(); self.assertFalse(current['unusedAssets'])
        response = await self.request('POST', '/api/admin/branding/cleanup', {'assets': [url], 'confirmation': 'DELETE UNUSED'}, owner); self.assertEqual(response.status, 409)
        self.assertEqual((await self.client.get(url)).status, 200)
        response = await self.request('PUT', '/api/admin/branding', {**current, 'icon': ''}, owner); self.assertEqual(response.status, 200)
        response = await self.request('POST', '/api/admin/branding/cleanup', {'assets': [url], 'confirmation': 'DELETE UNUSED'}, owner); self.assertEqual(response.status, 200)
        self.assertEqual((await self.client.get(url)).status, 404)

    async def test_policy_requires_current_password_and_strengthens_all_new_password_paths(self):
        owner, _, _ = await self.login('owner')
        response = await self.policy(owner, {'minimumPasswordLength': 20}, password='wrong'); self.assertEqual(response.status, 403)
        self.assertEqual(self.service.security_policy()['minimumPasswordLength'], 12)
        response = await self.policy(owner, {'minimumPasswordLength': 20}); self.assertEqual(response.status, 200)
        response = await self.request('POST', '/api/admin/users', {'username': 'newuser', 'password': 'Correct password!'}, owner); self.assertEqual(response.status, 400)
        response = await self.request('POST', '/api/account/password', {'currentPassword': 'Correct password!', 'newPassword': 'Short new password', 'confirmation': 'Short new password'}, owner); self.assertEqual(response.status, 400)

    async def test_session_limits_shorten_existing_sessions_and_bound_persistent_login(self):
        owner, _, _ = await self.login('owner'); alice, _, _ = await self.login()
        self.service.store.db.execute("UPDATE sessions SET created=? WHERE user_id='@alice:test'", (time.time() - 7200,))
        response = await self.policy(owner, {'sessionHours': 1, 'persistentDays': 2}); self.assertEqual(response.status, 200)
        response = await self.request('GET', '/api/auth/session', cookie=alice); self.assertEqual(response.status, 401)
        await self.login(remember=True)
        row = self.service.store.db.execute("SELECT created,expires FROM sessions WHERE user_id='@alice:test' AND persistent=1").fetchone()
        self.assertAlmostEqual(row['expires'] - row['created'], 2 * 86400, delta=1)

    async def test_mandatory_mfa_allows_only_enrollment_then_prevents_disabling_last_factor(self):
        owner, _, _ = await self.login('owner'); alice, _, _ = await self.login()
        response = await self.policy(owner, {'mfaRequirement': 'everyone'}); self.assertEqual(response.status, 200)
        for cookie in (owner, alice):
            response = await self.request('GET', '/api/auth/session', cookie=cookie); self.assertTrue((await response.json())['mfaEnrollmentRequired'])
            response = await self.request('GET', '/api/matrix/_matrix/client/v3/sync', cookie=cookie); self.assertEqual(response.status, 403); self.assertEqual((await response.json())['errcode'], 'MFA_ENROLLMENT_REQUIRED')
        response = await self.request('POST', '/api/account/mfa/totp/start', {'password': 'Correct password!'}, alice)
        self.assertEqual(response.status, 200); setup = await response.json()
        response = await self.request('POST', '/api/account/mfa/totp/complete', {'challengeId': setup['challengeId'], 'code': totp(setup['secret'], int(time.time()) // 30)}, alice)
        self.assertEqual(response.status, 200); codes = (await response.json())['recoveryCodes']
        response = await self.request('GET', '/api/matrix/_matrix/client/v3/sync', cookie=alice); self.assertEqual(response.status, 200)
        response = await self.request('POST', '/api/account/mfa/disable', {'password': 'Correct password!', 'method': 'recovery', 'code': codes[0]}, alice); self.assertEqual(response.status, 400)
        self.assertTrue(self.service.store.account('@alice:test')['totp'])

    async def test_admin_only_mfa_and_registration_disabled_have_real_server_effects(self):
        owner, _, _ = await self.login('owner'); alice, _, _ = await self.login()
        response = await self.policy(owner, {'registrationMode': 'disabled'}); self.assertEqual(response.status, 200)
        response = await self.request('POST', '/api/admin/users', {'username': 'newuser', 'password': 'Correct password!'}, owner); self.assertEqual(response.status, 403)
        response = await self.policy(owner, {'mfaRequirement': 'admins'}); self.assertEqual(response.status, 200)
        response = await self.request('GET', '/api/matrix/_matrix/client/v3/sync', cookie=alice); self.assertEqual(response.status, 200)
        response = await self.request('GET', '/api/admin/users', cookie=owner); self.assertEqual(response.status, 403); self.assertEqual((await response.json())['errcode'], 'MFA_ENROLLMENT_REQUIRED')

    async def test_policy_login_attempt_limit_and_role_lookup_failure_cannot_remove_mfa_gate(self):
        owner, _, _ = await self.login('owner')
        response = await self.policy(owner, {'loginPerAccountPerFiveMinutes': 3, 'mfaRequirement': 'admins'}); self.assertEqual(response.status, 200)
        for expected in (403, 403, 403, 429):
            response = await self.request('POST', '/api/auth/login', {'username': 'unknown-user', 'password': 'wrong'})
            self.assertEqual(response.status, expected)
        original = self.service.matrix
        async def unavailable(method, path, body=None, token=None, expected=True):
            if path.endswith('/admin'): return 503, {}
            return await original(method, path, body, token, expected)
        self.service.matrix = unavailable
        response = await self.request('GET', '/api/auth/session', cookie=owner); self.assertEqual(response.status, 502)
        self.assertTrue(self.service.store.account('@owner:test')['known_admin'])


if __name__ == '__main__': unittest.main()
