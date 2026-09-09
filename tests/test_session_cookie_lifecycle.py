"""Real HTTP regressions for cookie replacement and delayed response publication."""
import asyncio
import time
import unittest

from api.server import COOKIE
from tests import test_api as fixture


class SessionCookieTests(unittest.IsolatedAsyncioTestCase):
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login
    asyncTearDown = fixture.AccountAPITests.asyncTearDown

    async def asyncSetUp(self):
        await fixture.AccountAPITests.asyncSetUp(self)
        self.owner, _, _ = await self.login('owner')
        self.alice, self.alice_session, _ = await self.login()

    def session(self, cookie):
        return self.service.store.db.execute('SELECT * FROM sessions WHERE cookie_hash=? OR previous_hash=?', (self.service.store.digest(cookie), self.service.store.digest(cookie))).fetchone()

    async def replacement(self, user='owner'):
        response = await self.request('POST', '/api/auth/login', {'username': user, 'password': 'Correct password!'}, self.alice)
        self.assertEqual(response.status, 200, await response.text())
        return response.cookies[COOKIE].value

    async def replace_while_privacy_body_waits(self, user):
        previous = self.session(self.alice)
        old_native = self.service.store.open(previous['token'])
        self.service.store.db.execute('UPDATE sessions SET rotated=? WHERE id=?', (time.time() - 901, previous['id']))
        entered, release = asyncio.Event(), asyncio.Event()
        authenticate = self.service.authenticate
        def checked(request):
            result = authenticate(request)
            if request.path == '/api/social/privacy': entered.set()
            return result
        self.service.authenticate = checked
        async def chunks():
            yield b'{"requests":"'
            await release.wait()
            yield b'everyone"}'
        pending = asyncio.create_task(self.client.put('/api/social/privacy', data=chunks(), headers={
            'Origin': self.config.public_url, 'Cookie': COOKIE + '=' + self.alice, 'Content-Type': 'application/json'}))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            new_cookie = await self.replacement(user)
        finally:
            release.set()
        old_response = await asyncio.wait_for(pending, 2)
        self.assertEqual(old_response.status, 401, await old_response.text())
        self.assertNotIn('Set-Cookie', old_response.headers)
        self.assertFalse(self.service.store.db.execute("SELECT 1 FROM social_preferences WHERE user_id='@alice:test'").fetchone())
        self.assertEqual((await self.request('GET', '/api/auth/session', cookie=self.alice)).status, 401)
        self.assertEqual((await self.request('GET', '/api/auth/session', cookie=self.owner)).status, 200)
        current = await self.request('GET', '/api/auth/session', cookie=new_cookie)
        self.assertEqual((await current.json())['userId'], '@' + user + ':test')
        # The browser cookie expires; no native logout/device/key deletion occurs.
        self.assertEqual(self.tokens[old_native], ('@alice:test', self.alice_session['deviceId']))
        self.assertFalse(any(path.endswith(('/logout', '/delete_devices')) for _, path, _, _ in self.upstream_calls))
        self.assertLessEqual(self.session(self.alice)['expires'], time.time())

    async def test_new_account_cookie_expires_previous_browser_session_before_privacy_write(self):
        await self.replace_while_privacy_body_waits('owner')

    async def test_same_account_new_device_expires_previous_browser_session_without_native_logout(self):
        await self.replace_while_privacy_body_waits('alice')

    async def test_failed_replacement_keeps_previous_and_unrelated_sessions_and_native_devices(self):
        previous = self.session(self.alice)
        devices = dict(self.tokens)
        response = await self.request('POST', '/api/auth/login', {'username': 'owner', 'password': 'Incorrect password!'}, self.alice)
        self.assertNotEqual(response.status, 200)
        self.assertNotIn('Set-Cookie', response.headers)
        self.assertEqual(self.session(self.alice)['expires'], previous['expires'])
        self.assertEqual(self.tokens, devices)
        self.assertEqual((await self.request('GET', '/api/auth/session', cookie=self.alice)).status, 200)
        self.assertEqual((await self.request('GET', '/api/auth/session', cookie=self.owner)).status, 200)

    async def delayed_proxy(self):
        entered, release = asyncio.Event(), asyncio.Event()
        old = self.session(self.alice)
        self.service.store.db.execute('UPDATE sessions SET rotated=? WHERE id=?', (time.time() - 901, old['id']))
        async def upstream(request, _):
            if request.path == '/_matrix/client/v3/versions':
                entered.set(); await release.wait()
        self.upstream_response = upstream
        pending = asyncio.create_task(self.request('GET', '/api/matrix/_matrix/client/v3/versions', cookie=self.alice))
        await asyncio.wait_for(entered.wait(), 2)
        return pending, release, old

    async def test_streamed_response_does_not_publish_rotation_from_replaced_session(self):
        pending, release, _ = await self.delayed_proxy()
        try:
            new_cookie = await self.replacement()
        finally:
            release.set()
        response = await asyncio.wait_for(pending, 2)
        self.assertEqual(response.status, 200)
        self.assertNotIn('Set-Cookie', response.headers)
        current = await self.request('GET', '/api/auth/session', cookie=new_cookie)
        self.assertEqual((await current.json())['userId'], '@owner:test')

    async def delayed_rotation(self, expire_grace):
        pending, release, old = await self.delayed_proxy()
        first_rotation = self.service.store.open(self.session(self.alice)['cookie'])
        self.service.store.db.execute('UPDATE sessions SET rotated=? WHERE id=?', (time.time() - 901, old['id']))
        try:
            second = await self.request('GET', '/api/auth/session', cookie=first_rotation)
            newest = second.cookies[COOKIE].value
            self.assertNotEqual(first_rotation, newest)
            if expire_grace:
                self.service.store.db.execute('UPDATE sessions SET previous_until=0 WHERE id=?', (old['id'],))
        finally:
            release.set()
        response = await asyncio.wait_for(pending, 2)
        if expire_grace:
            self.assertNotIn('Set-Cookie', response.headers)
        else:
            self.assertEqual(response.cookies[COOKIE].value, newest)
        self.assertEqual((await self.request('GET', '/api/auth/session', cookie=newest)).status, 200)

    async def test_delayed_valid_grace_response_publishes_latest_rotation(self):
        await self.delayed_rotation(False)

    async def test_delayed_cookie_outside_rotation_grace_is_not_published(self):
        await self.delayed_rotation(True)

    async def test_expired_session_does_not_publish_a_delayed_rotation(self):
        pending, release, old = await self.delayed_proxy()
        self.service.store.db.execute('UPDATE sessions SET expires=0 WHERE id=?', (old['id'],))
        release.set()
        response = await asyncio.wait_for(pending, 2)
        self.assertNotIn('Set-Cookie', response.headers)


if __name__ == '__main__':
    unittest.main()
