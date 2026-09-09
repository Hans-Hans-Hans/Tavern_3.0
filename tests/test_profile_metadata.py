import time
import unittest
from urllib.parse import unquote, urlsplit

from api.profile_metadata import creation_time
from tests import test_api_admin_users as fixture


class ProfileMetadataTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.AdminUserTests.asyncTearDown
    request = fixture.AdminUserTests.request
    login = fixture.AdminUserTests.login

    async def asyncSetUp(self):
        await fixture.AdminUserTests.asyncSetUp(self)
        await self.login('owner')
        self.lookups = []
        original = self.service.matrix
        async def matrix(method, path, body=None, token=None, expected=True):
            if path.startswith('/_synapse/admin/v2/users/') and not expected:
                target = unquote(urlsplit(path).path).removeprefix('/_synapse/admin/v2/users/')
                self.lookups.append(target)
                if target not in self.users:
                    return 404, {}
            return await original(method, path, body, token, expected)
        self.service.matrix = matrix

    async def profile(self, cookie, target='@alice:test', room='!room:test'):
        return await self.request('GET', '/api/profiles/' + target + '/account' + ('?roomId=' + room if room else ''), cookie=cookie)

    async def test_self_date_comes_only_from_native_account_and_private_fields_are_omitted(self):
        alice, _, _ = await self.login()
        self.service.store.db.execute("UPDATE accounts SET created=1,email='private@example.com' WHERE user_id='@alice:test'")
        result = await self.profile(alice, room=None)
        self.assertEqual(result.status, 200, await result.text())
        self.assertEqual(await result.json(), {'userId': '@alice:test', 'createdAt': 1700000000000, 'source': 'homeserver'})
        self.assertEqual(result.headers['Cache-Control'], 'no-store')
        self.assertNotIn('password', await result.text())
        self.assertNotIn('private@example.com', await result.text())
        self.assertFalse(self.inventory_calls)

    async def test_strangers_cannot_enumerate_and_both_shared_memberships_must_be_current(self):
        owner, _, _ = await self.login('owner')
        self.rooms['!room:test']['members']['@alice:test'] = 'leave'
        self.assertEqual((await self.profile(owner)).status, 403)
        self.assertFalse(self.lookups)
        self.rooms['!room:test']['members']['@alice:test'] = 'join'
        self.rooms['!room:test']['members']['@owner:test'] = 'leave'
        self.assertEqual((await self.profile(owner)).status, 403)
        self.assertEqual((await self.profile(owner, target='@unknown:test')).status, 403)
        self.assertFalse(self.lookups)
        self.assertEqual((await self.profile(None)).status, 401)

    async def test_cached_native_timestamp_does_not_cache_membership_authority(self):
        owner, _, _ = await self.login('owner')
        self.assertEqual((await self.profile(owner)).status, 200)
        self.assertEqual((await self.profile(owner)).status, 200)
        self.assertEqual(self.lookups, ['@alice:test'])
        self.rooms['!room:test']['members']['@alice:test'] = 'leave'
        self.assertEqual((await self.profile(owner)).status, 403)
        self.assertEqual(self.lookups, ['@alice:test'])

    async def test_unknown_and_remote_dates_are_explicit_and_cache_is_bounded(self):
        owner, _, _ = await self.login('owner')
        self.rooms['!room:test']['members']['@remote:elsewhere'] = 'join'
        result = await self.profile(owner, '@remote:elsewhere')
        self.assertEqual(result.status, 200)
        self.assertEqual(await result.json(), {'userId': '@remote:elsewhere', 'createdAt': None, 'source': None})
        cache = self.service.profile_metadata_cache
        for index in range(512): cache['@cached' + str(index) + ':test'] = (time.monotonic() + 600, 1700000000000)
        result = await self.profile(owner)
        self.assertEqual(result.status, 200)
        self.assertEqual(len(cache), 512)
        self.assertNotIn('@remote:elsewhere', cache)
        self.assertNotIn('@cached0:test', cache)

    async def test_revoked_session_during_native_lookup_does_not_return_metadata(self):
        alice, _, _ = await self.login()
        original = self.service.matrix
        async def matrix(method, path, body=None, token=None, expected=True):
            value = await original(method, path, body, token, expected)
            if path.endswith('/users/%40alice%3Atest'):
                self.service.store.db.execute("DELETE FROM sessions WHERE user_id='@alice:test'")
            return value
        self.service.matrix = matrix
        result = await self.profile(alice, room=None)
        self.assertEqual(result.status, 401)
        self.assertNotIn('createdAt', await result.text())

    def test_timestamp_validation_preserves_unknown_instead_of_fabricating_a_date(self):
        for value in (None, False, True, '1700000000', -1, 0, 1.5, 9999999999999999):
            self.assertIsNone(creation_time(value))
        self.assertEqual(creation_time(1700000000), 1700000000000)
        self.assertEqual(creation_time(1700000000000), 1700000000000)


if __name__ == '__main__': unittest.main()
