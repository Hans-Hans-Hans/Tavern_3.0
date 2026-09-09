import asyncio
from pathlib import Path
import sqlite3
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from synapse_modules.channel_policy import ChannelPolicy, CHANNEL, TIMEOUT, valid_channel
from synapse_modules.tavern_policy import permissions, rank


def event(kind, sender="@member:test", content=None, key=None, identity="$event"):
    return SimpleNamespace(type=kind, sender=sender, content=content or {}, state_key=key, event_id=identity, room_id="!room:test")


class ChannelPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = sqlite3.connect(Path(self.directory.name) / "synapse.sqlite3")
        self.redacted = None
        async def lookup(_identity, allow_none=False):
            return self.redacted
        async def interaction(_name, task):
            cursor = self.database.cursor()
            try:
                result = task(cursor)
                self.database.commit()
                return result
            finally:
                cursor.close()
        self.api = SimpleNamespace(_store=SimpleNamespace(get_event=lookup, db_pool=SimpleNamespace(runInteraction=interaction)))
        self.policy = ChannelPolicy(self.api, permissions, rank)
        self.state = {
            ("m.room.power_levels", ""): event("m.room.power_levels", content={"users": {"@owner:test": 100, "@mod:test": 50, "@peer:test": 50}, "invite": 50, "redact": 50, "kick": 50}),
            ("m.room.member", "@member:test"): event("m.room.member", content={"membership": "join"}),
            ("m.room.member", "@mod:test"): event("m.room.member", content={"membership": "join"}),
            ("m.room.member", "@peer:test"): event("m.room.member", content={"membership": "join"}),
        }

    async def asyncTearDown(self):
        self.database.close()
        self.directory.cleanup()

    async def test_archive_enforced_for_owner_messages_and_calls_but_allows_cleanup(self):
        self.state[(CHANNEL, "")] = event(CHANNEL, content={"version": 1, "archived": True})
        for kind in ("m.room.message", "m.room.encrypted", "m.reaction", "m.call.invite"):
            self.assertFalse(await self.policy.check(event(kind, sender="@owner:test"), self.state, []))
        self.assertTrue(await self.policy.check(event("org.matrix.msc3401.call.member", content={"memberships": []}), self.state, []))
        self.assertTrue(await self.policy.check(event("m.room.member", key="@member:test", content={"membership": "leave"}), self.state, []))
        self.assertTrue(await self.policy.check(event(CHANNEL, sender="@owner:test", key="", content={"version": 1, "archived": False}), self.state, []))

    async def test_timeout_needs_native_hierarchy_and_cannot_target_self(self):
        until = int(time.time() * 1000) + 3600000
        self.assertTrue(await self.policy.check(event(TIMEOUT, sender="@mod:test", key="_member:test", content={"until": until, "io.tavern.previous_event": None}), self.state, []))
        for target in ("@owner:test", "@peer:test", "@mod:test"):
            self.assertFalse(await self.policy.check(event(TIMEOUT, sender="@mod:test", key="_" + target[1:], content={"until": until, "io.tavern.previous_event": None}), self.state, []))
        self.assertFalse(await self.policy.check(event(TIMEOUT, key="_mod:test", content={"until": until, "io.tavern.previous_event": None}), self.state, []))
        self.assertFalse(await self.policy.check(event(TIMEOUT, sender="@mod:test", key="_member:test", content={"until": until + 29 * 86400000, "io.tavern.previous_event": None}), self.state, []))

    async def test_timeout_expiry_server_time_and_parent_inheritance(self):
        with patch("synapse_modules.channel_policy.time.time", return_value=1000):
            self.state[(TIMEOUT, "@member:test")] = event(TIMEOUT, content={"until": 1000001})
            self.assertFalse(await self.policy.check(event("m.room.encrypted"), self.state, []))
            self.state[(TIMEOUT, "@member:test")].content["until"] = 999999
            self.assertTrue(await self.policy.check(event("m.room.encrypted"), self.state, []))
            roles = {"owner": "@owner:test", "roles": [{"id": "everyone", "position": 0, "permissions": []}], "members": {}}
            parent = {(TIMEOUT, "@member:test"): event(TIMEOUT, content={"until": 1000001})}
            self.assertFalse(await self.policy.check(event("m.room.message"), self.state, [("!parent:test", roles, parent)]))

    async def test_slow_mode_is_atomic_durable_and_uses_server_clock(self):
        self.state[(CHANNEL, "")] = event(CHANNEL, content={"slowModeSeconds": 60})
        with patch("synapse_modules.channel_policy.time.time", return_value=1000):
            results = await asyncio.gather(*(self.policy.check(event("m.room.encrypted", identity="$" + str(index)), self.state, []) for index in range(5)))
            self.assertEqual(sum(results), 1)
            restarted = ChannelPolicy(self.api, permissions, rank)
            self.assertFalse(await restarted.check(event("m.room.message", identity="$after-restart"), self.state, []))
            self.assertTrue(await restarted.check(event("m.room.message", sender="@mod:test", identity="$moderator"), self.state, []))
        with patch("synapse_modules.channel_policy.time.time", return_value=1060):
            self.assertTrue(await self.policy.check(event("m.room.encrypted", identity="$later"), self.state, []))

    async def test_read_only_roles_and_metadata_redaction_cannot_remove_restrictions(self):
        self.state[(CHANNEL, "")] = event(CHANNEL, content={"kind": "read-only"})
        self.assertFalse(await self.policy.check(event("m.room.encrypted"), self.state, []))
        self.assertTrue(await self.policy.check(event("m.room.encrypted", sender="@mod:test"), self.state, []))
        self.assertTrue(await self.policy.check(event("m.reaction"), self.state, []))
        self.redacted = event(TIMEOUT)
        self.assertFalse(await self.policy.check(event("m.room.redaction", sender="@owner:test", content={"redacts": "$timeout"}), self.state, []))

    async def test_granular_timeout_role_required_even_with_native_power(self):
        roles = {"owner": "@owner:test", "roles": [{"id": "everyone", "position": 0, "permissions": []}, {"id": "mod", "position": 50, "permissions": ["kick"]}], "members": {"@mod:test": ["mod"]}}
        action = event(TIMEOUT, sender="@mod:test", key="_member:test", content={"until": int(time.time() * 1000) + 100000, "io.tavern.previous_event": None})
        self.assertFalse(await self.policy.check(action, self.state, [("!parent:test", roles, {})]))
        roles["roles"][1]["permissions"].append("timeout")
        self.assertTrue(await self.policy.check(action, self.state, [("!parent:test", roles, {})]))

    def test_invalid_channel_restrictions_rejected(self):
        for value in ({"slowModeSeconds": True}, {"slowModeSeconds": -1}, {"slowModeSeconds": 21601}, {"archived": "true"}, {"kind": "unknown"}):
            self.assertFalse(valid_channel(value))


if __name__ == "__main__":
    unittest.main()
