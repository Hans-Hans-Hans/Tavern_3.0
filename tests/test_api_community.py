import asyncio
import json
import re
import unittest

from tests import test_api as fixture
from api.server import APIError


class CommunityAPITests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.AccountAPITests.asyncSetUp
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def create_invitation(self, **options):
        owner, _, _ = await self.login("owner")
        response = await self.request("POST", "/api/invitations", {"roomId": "!room:test", "maxUses": 1, **options}, owner)
        self.assertEqual(response.status, 201, await response.text())
        return owner, await response.json()

    async def add_user(self, name):
        self.users["@" + name + ":test"] = {"password": "Correct password!", "admin": False}
        return (await self.login(name))[0]

    async def test_invitation_requires_matrix_permission_and_never_lists_secret(self):
        owner, invitation = await self.create_invitation()
        bob = await self.add_user("bob")
        self.rooms["!room:test"]["members"]["@bob:test"] = "join"
        denied = await self.request("POST", "/api/invitations", {"roomId": "!room:test"}, bob)
        self.assertEqual(denied.status, 403)
        listing = await self.request("GET", "/api/invitations", cookie=owner)
        self.assertNotIn(invitation["token"], await listing.text())
        self.assertNotIn("token", (await listing.json())["invitations"][0])

    async def test_invitation_single_use_concurrency_and_idempotent_redemption(self):
        _, invitation = await self.create_invitation()
        bob, charlie = await self.add_user("bob"), await self.add_user("charlie")
        responses = await asyncio.gather(self.request("POST", "/api/invitations/redeem", {"token": invitation["token"]}, bob), self.request("POST", "/api/invitations/redeem", {"token": invitation["token"]}, charlie))
        self.assertEqual(sorted(response.status for response in responses), [200, 409])
        winner = bob if responses[0].status == 200 else charlie
        repeated = await self.request("POST", "/api/invitations/redeem", {"token": invitation["token"]}, winner)
        self.assertEqual(repeated.status, 200)
        row = self.service.store.db.execute("SELECT uses FROM invitations WHERE id=?", (invitation["id"],)).fetchone()
        self.assertEqual(row[0], 1)
        self.assertFalse(any(token.startswith("impersonation-") for token in self.tokens))
        login_calls = [call for call in self.upstream_calls if call[1].startswith("/_synapse/admin/v1/users/") and call[1].endswith("/login")]
        self.assertTrue(login_calls[0][2]["valid_until_ms"] > 0)
        self.assertFalse(any("make_room_admin" in call[1] for call in self.upstream_calls))

    async def test_invitation_rechecks_issuer_permissions_and_email(self):
        _, invitation = await self.create_invitation(email="bob@example.com")
        bob = await self.add_user("bob")
        denied = await self.request("POST", "/api/invitations/redeem", {"token": invitation["token"]}, bob)
        self.assertEqual(denied.status, 403)
        self.service.store.db.execute("UPDATE accounts SET email='bob@example.com',verified=1 WHERE user_id='@bob:test'")
        self.rooms["!room:test"]["powers"]["users"]["@owner:test"] = 0
        denied = await self.request("POST", "/api/invitations/redeem", {"token": invitation["token"]}, bob)
        self.assertEqual(denied.status, 403)
        self.assertEqual(self.service.store.db.execute("SELECT uses FROM invitations WHERE id=?", (invitation["id"],)).fetchone()[0], 0)

    async def test_email_invitation_requires_explicit_delivery_and_an_exact_recipient(self):
        owner, invitation = await self.create_invitation(email='bob@example.com')
        self.service.send_email.assert_not_awaited()
        for values in ({'sendEmail': True}, {'sendEmail': True, 'domain': 'example.com'}):
            result = await self.request('POST', '/api/invitations', {'roomId': '!room:test', **values}, owner)
            self.assertEqual(result.status, 400)
        self.service.store.set('smtp', {'enabled': False})
        result = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'sendEmail': True, 'email': 'bob@example.com'}, owner)
        self.assertEqual(result.status, 400)
        self.assertEqual(self.service.store.db.execute('SELECT count(*) FROM invitations').fetchone()[0], 1)
        self.service.send_email.assert_not_awaited()

    async def test_invitation_email_is_normalized_and_partial_failure_returns_the_existing_link_once(self):
        self.rooms['!room:test']['name'] = 'Test\r\nBcc: unwanted@example.com\x00 server'
        owner, invitation = await self.create_invitation(email='bob@example.com', sendEmail=True)
        self.assertTrue(invitation['emailSent'])
        recipient, subject, message = self.service.send_email.call_args.args
        self.assertEqual(recipient, 'bob@example.com')
        self.assertNotRegex(subject, r'[\x00-\x1f\x7f-\x9f]')
        self.assertIn(invitation['url'], message)
        self.service.send_email.side_effect = APIError(502, 'Email delivery failed.', 'SMTP_FAILED')
        result = await self.request('POST', '/api/invitations', {'roomId': '!room:test', 'email': 'bob@example.com', 'sendEmail': True}, owner)
        self.assertEqual(result.status, 201, await result.text())
        partial = await result.json()
        self.assertFalse(partial['emailSent'])
        self.assertIn('email delivery failed', partial['warning'])
        self.assertIn(partial['token'], partial['url'])
        rows = self.service.store.db.execute('SELECT * FROM invitations').fetchall()
        self.assertEqual(len(rows), 2)
        self.assertNotIn(partial['token'], str([tuple(row) for row in rows]))
        listing = await self.request('GET', '/api/invitations', cookie=owner)
        self.assertNotIn(partial['token'], await listing.text())
        self.assertEqual((await self.request('GET', '/api/invitations/preview/' + partial['token'])).status, 200)

    async def test_revoked_invitation_cannot_be_redeemed(self):
        owner, invitation = await self.create_invitation()
        response = await self.request("DELETE", "/api/invitations/" + invitation["id"], cookie=owner)
        self.assertEqual(response.status, 200)
        bob = await self.add_user("bob")
        denied = await self.request("POST", "/api/invitations/redeem", {"token": invitation["token"]}, bob)
        self.assertEqual(denied.status, 404)

    async def test_reports_enforce_room_access_and_admin_queue_permissions(self):
        alice, _, _ = await self.login()
        owner, _, _ = await self.login("owner")
        bob = await self.add_user("bob")
        data = {"kind": "message", "roomId": "!room:test", "eventId": "$event", "reason": "Harassment", "evidence": "User-supplied excerpt"}
        denied = await self.request("POST", "/api/reports", data, bob)
        self.assertEqual(denied.status, 403)
        accepted = await self.request("POST", "/api/reports", data, alice)
        self.assertEqual(accepted.status, 201)
        identity = (await accepted.json())["id"]
        self.assertEqual((await self.request("GET", "/api/admin/reports", cookie=alice)).status, 403)
        queue = await self.request("GET", "/api/admin/reports", cookie=owner)
        self.assertEqual((await queue.json())["reports"][0]["reporter"], "@alice:test")
        result = await self.request("PUT", "/api/admin/reports/" + str(identity), {"status": "resolved", "note": "Internal review note"}, owner)
        self.assertEqual(result.status, 200)
        own = await self.request("GET", "/api/reports", cookie=alice)
        value = (await own.json())["reports"][0]
        self.assertEqual(value["status"], "resolved")
        self.assertNotIn("note", value)
        self.assertEqual((await (await self.request("GET", "/api/reports", cookie=bob)).json())["reports"], [])

    async def test_export_never_contains_tokens_factor_secrets_or_other_emails(self):
        alice, _, _ = await self.login()
        self.service.store.db.execute("UPDATE accounts SET email='alice@example.com',verified=1,totp=? WHERE user_id='@alice:test'", (self.service.store.seal("never-export-this-secret"),))
        response = await self.request("GET", "/api/account/export", cookie=alice)
        self.assertEqual(response.status, 200)
        value = await response.json()
        encoded = json.dumps(value)
        self.assertNotIn("real-secret-token", encoded)
        self.assertNotIn("never-export-this-secret", encoded)
        self.assertNotIn("cookie", encoded)
        self.assertEqual(value["account"]["email"], "alice@example.com")
        self.assertEqual(value["roomMemberships"], ["!room:test"])
        self.assertIn("attachment", response.headers["Content-Disposition"])

    async def test_registration_requires_policy_and_verified_email(self):
        data = {"username": "newuser", "password": "A strong new password!", "confirmation": "A strong new password!", "email": "new@example.com", "displayName": "New user"}
        denied = await self.request("POST", "/api/auth/register/start", data)
        self.assertEqual(denied.status, 403)
        self.service.store.set("policy", {"registrationMode": "open"})
        started = await self.request("POST", "/api/auth/register/start", data)
        self.assertEqual(started.status, 200)
        identity = (await started.json())["challengeId"]
        code = re.search(r"\b\d{6}\b", self.service.send_email.call_args.args[2])[0]
        wrong = await self.request("POST", "/api/auth/register/complete", {"challengeId": identity, "code": "bad"})
        self.assertEqual(wrong.status, 400)
        self.assertNotIn("@newuser:test", self.users)
        accepted = await self.request("POST", "/api/auth/register/complete", {"challengeId": identity, "code": code})
        self.assertEqual(accepted.status, 200, await accepted.text())
        self.assertTrue((await accepted.json())["emailVerified"])
        self.assertFalse(self.users["@newuser:test"]["admin"])

    async def test_registration_invitation_policy_is_checked_again_before_create(self):
        _, invitation = await self.create_invitation()
        self.service.store.set("policy", {"registrationMode": "invite"})
        data = {"username": "newuser", "password": "A strong new password!", "confirmation": "A strong new password!", "email": "new@example.com", "inviteToken": invitation["token"]}
        started = await self.request("POST", "/api/auth/register/start", data)
        identity = (await started.json())["challengeId"]
        code = re.search(r"\b\d{6}\b", self.service.send_email.call_args.args[2])[0]
        self.service.store.db.execute("UPDATE invitations SET revoked=1 WHERE id=?", (invitation["id"],))
        response = await self.request("POST", "/api/auth/register/complete", {"challengeId": identity, "code": code})
        self.assertEqual(response.status, 404)
        self.assertNotIn("@newuser:test", self.users)


if __name__ == "__main__":
    unittest.main()
