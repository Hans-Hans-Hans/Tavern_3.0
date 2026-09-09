import json
from pathlib import Path
import unittest

from integrations.configuration import load_configuration
from tests import test_api as fixture


class IntegrationAPITests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.AccountAPITests.asyncTearDown
    request = fixture.AccountAPITests.request
    login = fixture.AccountAPITests.login

    async def asyncSetUp(self):
        await fixture.AccountAPITests.asyncSetUp(self)
        self.folder = Path(self.directory.name) / "bot-config"
        self.folder.mkdir()
        self.service.integrations.directory = self.folder
        self.service.integrations.enabled = True

    async def new_hook(self, owner, identity="builds", revision=""):
        return await self.request("POST", "/api/admin/integrations/hooks", {"id": identity, "roomId": "!room:test", "allowedUsers": ["@alice:test", "@owner:test"], "confirmation": "!room:test", "revision": revision}, owner)

    async def test_webhook_secret_returned_only_once_and_bot_identity_untouched(self):
        owner, _, _ = await self.login("owner")
        (self.folder / "session.json").write_text('{"access_token":"never-expose-this"}')
        (self.folder / "pickle.key").write_text("preserve-crypto-identity")
        response = await self.new_hook(owner)
        self.assertEqual(response.status, 201, await response.text())
        created = await response.json()
        self.assertGreaterEqual(len(created["secret"]), 32)
        config, keys, revision = load_configuration(self.folder / "bot.json")
        self.assertEqual(keys["builds"].decode(), created["secret"])
        self.assertEqual(revision, created["revision"])
        listing = await self.request("GET", "/api/admin/integrations", cookie=owner)
        text = await listing.text()
        self.assertNotIn(created["secret"], text)
        self.assertNotIn("never-expose-this", text)
        self.assertNotIn("secret_file", text)
        self.assertEqual((self.folder / "pickle.key").read_text(), "preserve-crypto-identity")

    async def test_rotate_and_revoke_never_reuse_destination_identity(self):
        owner, _, _ = await self.login("owner")
        original = await (await self.new_hook(owner)).json()
        response = await self.request("POST", "/api/admin/integrations/hooks/builds/rotate", {"revision": original["revision"], "confirmation": "builds"}, owner)
        self.assertEqual(response.status, 200)
        rotated = await response.json()
        self.assertNotEqual(original["secret"], rotated["secret"])
        _, keys, _ = load_configuration(self.folder / "bot.json")
        self.assertEqual(keys["builds"].decode(), rotated["secret"])
        self.assertEqual(len(list(self.folder.glob("managed-*.hmac"))), 1)
        stale = await self.request("DELETE", "/api/admin/integrations/hooks/builds", {"revision": original["revision"], "confirmation": "builds"}, owner)
        self.assertEqual(stale.status, 409)
        removed = await self.request("DELETE", "/api/admin/integrations/hooks/builds", {"revision": rotated["revision"], "confirmation": "builds"}, owner)
        self.assertEqual(removed.status, 200)
        reused = await self.new_hook(owner, revision=(await removed.json())["revision"])
        self.assertEqual(reused.status, 409)
        self.assertEqual(len(list(self.folder.glob("managed-*.hmac"))), 0)

    async def test_hook_creation_requires_admin_and_all_members_approved(self):
        user, _, _ = await self.login()
        denied = await self.new_hook(user)
        self.assertEqual(denied.status, 403)
        owner, _, _ = await self.login("owner")
        self.rooms["!room:test"]["members"]["@other:test"] = "join"
        denied = await self.new_hook(owner)
        self.assertEqual(denied.status, 400)
        self.assertFalse((self.folder / "bot.json").exists())

    async def test_fingerprint_must_be_explicit_and_match_current_device(self):
        owner, _, _ = await self.login("owner")
        data = {"userId": "@alice:test", "deviceId": "PHONE", "fingerprint": "B" * 43, "confirmation": "VERIFIED", "revision": ""}
        mismatch = await self.request("POST", "/api/admin/integrations/pins", data, owner)
        self.assertEqual(mismatch.status, 400)
        data["fingerprint"] = "A" * 43
        good = await self.request("POST", "/api/admin/integrations/pins", data, owner)
        self.assertEqual(good.status, 200)
        data["revision"] = (await good.json())["revision"]
        removed = await self.request("DELETE", "/api/admin/integrations/pins", data, owner)
        self.assertEqual(removed.status, 200)
        config, _, _ = load_configuration(self.folder / "bot.json")
        self.assertEqual(config["trusted_devices"], {})

    async def test_device_header_rejects_stale_tab_account_actions(self):
        old, old_session, _ = await self.login()
        new, _, _ = await self.login("owner")
        response = await self.client.get("/api/account/security", headers={"Cookie": fixture.COOKIE + "=" + new, "X-Tavern-Device": old_session["deviceId"]})
        self.assertEqual(response.status, 401)


if __name__ == "__main__":
    unittest.main()
