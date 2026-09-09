import unittest
from urllib.parse import urlencode
from tests import test_api as fixture


class AuditAPITests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.AccountAPITests.asyncSetUp
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def test_pagination_filters_and_authority(self):
        member, _, _ = await self.login()
        denied = await self.request('GET', '/api/admin/audit', cookie=member)
        self.assertEqual(denied.status, 403)
        owner, _, _ = await self.login('owner')
        for i in range(105):
            self.service.audit('@alice:test', 'password_changed', '@alice:test', str(i))
        self.service.audit('@alice:test', 'user_updated', 'excluded')
        query = urlencode({'actor': '@alice:test', 'security': 'true'})
        first = await (await self.request('GET', '/api/admin/audit?' + query, cookie=owner)).json()
        second = await (await self.request('GET', '/api/admin/audit?' + query + '&before=' + str(first['next']), cookie=owner)).json()
        self.assertEqual(len(first['events']), 100)
        self.assertEqual(len(second['events']), 6)  # Includes the member login.
        self.assertIsNone(second['next'])
        ids = [event['id'] for event in first['events'] + second['events']]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertNotIn('user_updated', [event['action'] for event in first['events'] + second['events']])
        injection = await (await self.request('GET', '/api/admin/audit?' + urlencode({'actor': "' OR 1=1 --"}), cookie=owner)).json()
        self.assertEqual(injection['events'], [])
        bad = await self.request('GET', '/api/admin/audit?before=9223372036854775808', cookie=owner)
        self.assertEqual(bad.status, 400)

    async def test_login_failure_audit_is_sampled_and_secret_free(self):
        for _ in range(3):
            response = await self.request('POST', '/api/auth/login', {'username': 'alice', 'password': 'Never record this password'})
            self.assertEqual(response.status, 403)
        rows = self.service.store.db.execute("SELECT * FROM audit WHERE action='login_failed'").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['target'], 'alice')
        self.assertNotIn('Never record', str([dict(row) for row in rows]))
