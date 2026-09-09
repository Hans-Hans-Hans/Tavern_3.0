import re
import time
import unittest

from api.server import APIError
from tests import test_api_admin_users as fixture


class AssociatedEmailTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.AdminUserTests.asyncSetUp
    asyncTearDown = fixture.AdminUserTests.asyncTearDown
    request = fixture.AdminUserTests.request
    login = fixture.AdminUserTests.login
    action = fixture.AdminUserTests.action

    async def prepare(self):
        owner, _, _ = await self.login('owner')
        alice, _, _ = await self.login()
        self.service.store.db.execute("UPDATE accounts SET email='alice@example.com',verified=0 WHERE user_id='@alice:test'")
        self.service.send_email.reset_mock()
        return owner, alice

    def mailed_code(self):
        return re.search(r'\b\d{6}\b', self.service.send_email.call_args.args[2])[0]

    async def complete(self, cookie, code):
        return await self.request('POST', '/api/account/email/pending/complete', {'code': code}, cookie)

    async def test_staff_sends_only_to_associated_email_and_owner_alone_can_verify(self):
        owner, alice = await self.prepare()
        denied = await self.action(alice, 'resend_verification', '@owner:test')
        self.assertEqual(denied.status, 403)
        denied = await self.action(owner, 'resend_verification', password='wrong password')
        self.assertEqual(denied.status, 403)
        result = await self.action(owner, 'resend_verification')
        self.assertEqual(result.status, 200, await result.text())
        self.assertEqual(await result.json(), {'ok': True})
        self.assertEqual(self.service.send_email.call_args.args[0], 'alice@example.com')
        code = self.mailed_code()
        self.assertNotIn(code, await result.text())
        self.assertFalse(self.service.store.account('@alice:test')['verified'])
        self.assertEqual((await self.complete(owner, code)).status, 409)
        self.assertEqual((await self.complete(alice, 'wrong')).status, 400)
        result = await self.complete(alice, code)
        self.assertEqual(result.status, 200, await result.text())
        self.assertTrue(self.service.store.account('@alice:test')['verified'])
        self.assertEqual(self.service.store.account('@alice:test')['email'], 'alice@example.com')
        self.assertEqual((await self.complete(alice, code)).status, 409)
        audit = str([tuple(row) for row in self.service.store.db.execute('SELECT actor,action,target,detail FROM audit')])
        self.assertNotIn(code, audit)
        self.assertNotIn('alice@example.com', audit)

    async def test_email_substitution_verified_accounts_and_restricted_accounts_are_rejected(self):
        owner, _ = await self.prepare()
        for key in ('email', 'newEmail', 'recipient'):
            result = await self.action(owner, 'resend_verification', **{key: 'attacker@example.com'})
            self.assertEqual(result.status, 400)
        # These are separate eligibility scenarios, not repeated-password rate
        # behavior (covered independently by the account security suite).
        self.service.store.db.execute('DELETE FROM rate_limits')
        for flag in ('deactivated', 'locked', 'suspended'):
            self.users['@alice:test'][flag] = True
            self.assertEqual((await self.action(owner, 'resend_verification')).status, 403)
            self.users['@alice:test'][flag] = False
        self.service.store.db.execute("UPDATE accounts SET access_blocked='suspend' WHERE user_id='@alice:test'")
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 403)
        self.service.store.db.execute("UPDATE accounts SET access_blocked='',verified=1 WHERE user_id='@alice:test'")
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 409)
        self.service.store.db.execute("UPDATE accounts SET verified=0,email=NULL WHERE user_id='@alice:test'")
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 409)
        self.service.send_email.assert_not_awaited()

    async def test_resend_is_limited_old_code_is_replaced_and_smtp_failure_removes_challenge(self):
        owner, alice = await self.prepare()
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 200)
        first = self.service.store.db.execute("SELECT id FROM challenges WHERE kind='associated-email'").fetchone()[0]
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 200)
        self.assertIsNone(self.service.store.db.execute('SELECT 1 FROM challenges WHERE id=?', (first,)).fetchone())
        self.service.send_email.side_effect = APIError(502, 'SMTP unavailable')
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 502)
        self.assertEqual(self.service.store.db.execute("SELECT count(*) FROM challenges WHERE kind='associated-email'").fetchone()[0], 0)
        self.service.send_email.side_effect = None
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 429)
        self.assertEqual((await self.complete(alice, '123456')).status, 409)

    async def test_changed_email_expired_code_and_new_credential_epoch_cannot_verify(self):
        owner, alice = await self.prepare()
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 200)
        code = self.mailed_code()
        self.service.store.db.execute("UPDATE accounts SET email='new@example.com' WHERE user_id='@alice:test'")
        self.assertEqual((await self.complete(alice, code)).status, 409)
        self.assertFalse(self.service.store.account('@alice:test')['verified'])
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 200)
        code = self.mailed_code()
        self.service.store.db.execute("UPDATE accounts SET credential_epoch=? WHERE user_id='@alice:test'", (time.time(),))
        self.assertEqual((await self.complete(alice, code)).status, 409)
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 200)
        code = self.mailed_code()
        self.service.store.db.execute("UPDATE challenges SET expires=0 WHERE kind='associated-email'")
        self.assertEqual((await self.complete(alice, code)).status, 409)
        self.assertFalse(self.service.store.account('@alice:test')['verified'])

    async def test_native_suspension_after_delivery_prevents_completion(self):
        owner, alice = await self.prepare()
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 200)
        code = self.mailed_code()
        self.users['@alice:test']['suspended'] = True
        self.assertEqual((await self.complete(alice, code)).status, 403)
        self.assertFalse(self.service.store.account('@alice:test')['verified'])

    async def test_staff_is_reauthorized_after_reading_target_account(self):
        owner, _ = await self.prepare()
        original = self.service.matrix
        async def matrix(method, path, body=None, token=None, expected=True):
            value = await original(method, path, body, token, expected)
            if path.endswith('/users/%40alice%3Atest'):
                self.users['@owner:test']['admin'] = False
            return value
        self.service.matrix = matrix
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 403)
        self.service.send_email.assert_not_awaited()

    async def test_code_attempt_limit_and_password_change_gate_are_preserved(self):
        owner, alice = await self.prepare()
        self.assertEqual((await self.action(owner, 'resend_verification')).status, 200)
        code = self.mailed_code()
        self.service.store.db.execute("UPDATE accounts SET password_change_required=1 WHERE user_id='@alice:test'")
        result = await self.complete(alice, code)
        self.assertEqual(result.status, 403)
        self.assertEqual((await result.json())['errcode'], 'PASSWORD_CHANGE_REQUIRED')
        self.service.store.db.execute("UPDATE accounts SET password_change_required=0 WHERE user_id='@alice:test'")
        for _ in range(5): self.assertEqual((await self.complete(alice, 'invalid')).status, 400)
        self.assertEqual((await self.complete(alice, code)).status, 400)
        self.assertFalse(self.service.store.account('@alice:test')['verified'])


if __name__ == '__main__': unittest.main()
