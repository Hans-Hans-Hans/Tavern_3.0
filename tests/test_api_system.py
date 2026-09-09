import unittest

from tests import test_api as fixture
from api.server import APIError
from api.system_policy import normalize_policy, public_status


class SystemPolicyTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.AccountAPITests.asyncSetUp
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def test_maintenance_blocks_normal_matrix_requests_but_preserves_admin_and_health(self):
        user, _, _ = await self.login()
        admin, _, _ = await self.login("owner")
        denied = await self.request("PUT", "/api/admin/policy", {"maintenance": {"enabled": True}}, user)
        self.assertEqual(denied.status, 403)
        enabled = await self.request("PUT", "/api/admin/policy", {"maintenance": {"enabled": True, "message": "Updating Tavern"}}, admin)
        self.assertEqual(enabled.status, 200)
        denied = await self.request("GET", "/api/matrix/_matrix/client/v3/sync", cookie=user)
        self.assertEqual(denied.status, 503)
        self.assertEqual((await denied.json())["errcode"], "MAINTENANCE_MODE")
        self.assertEqual((await self.request("GET", "/api/matrix/_matrix/client/v3/sync", cookie=admin)).status, 200)
        self.assertEqual((await self.request("GET", "/health")).status, 200)
        self.assertEqual((await self.request("GET", "/api/account/security", cookie=user)).status, 200)

    async def test_announcement_visibility_respects_schedule_and_never_exposes_admin_settings(self):
        policy = normalize_policy({"announcements": [{"id": "one", "title": "Notice", "message": "Details", "startAt": 100, "endAt": 200, "severity": "warning"}]}, now=100)
        self.service.store.set("policy", policy)
        self.assertEqual(public_status(self.service, now=99)["announcements"], [])
        self.assertEqual(public_status(self.service, now=100)["announcements"][0]["title"], "Notice")
        self.assertEqual(public_status(self.service, now=200)["announcements"], [])
        public = await self.request("GET", "/api/system/status")
        self.assertNotIn("smtp", await public.text())

    async def test_registration_settings_update_preserves_maintenance_policy(self):
        admin, _, _ = await self.login("owner")
        self.service.store.set("policy", {"maintenance": {"enabled": True, "message": "Updating"}, "announcements": []})
        response = await self.request("PUT", "/api/admin/settings", {"policy": {"registrationMode": "invite"}}, admin)
        self.assertEqual(response.status, 200)
        self.assertTrue(self.service.store.get("policy")["maintenance"]["enabled"])
        self.assertEqual(self.service.store.get("policy")["registrationMode"], "invite")

    def test_invalid_announcement_times_and_duplicate_ids_are_rejected(self):
        for announcements in ([{"title": "Title", "message": "Body", "startAt": 100, "endAt": 99}], [{"id": "same", "title": "One", "message": "Body"}, {"id": "same", "title": "Two", "message": "Body"}]):
            with self.assertRaises(APIError):
                normalize_policy({"announcements": announcements}, now=100)


if __name__ == "__main__":
    unittest.main()
