import json
from pathlib import Path
import tempfile
import sqlite3
import unittest

from integrations.configuration import cancel_unconfigured, load_configuration, persist_destinations


class BotConfigurationTests(unittest.TestCase):
    def test_rejects_secret_paths_outside_explicit_configuration_volume(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            path = folder / "bot.json"
            secret = folder / "hook.hmac"
            secret.write_text("x" * 48)
            value = {"homeserver": "http://synapse:8008", "hooks": {"builds": {"room_id": "!room:test", "allowed_users": ["@bot:test"], "secret_file": "/config/hook.hmac"}}, "trusted_devices": {}}
            path.write_text(json.dumps(value))
            _, keys, revision = load_configuration(path)
            self.assertEqual(keys["builds"], b"x" * 48)
            self.assertEqual(len(revision), 64)
            for unsafe in ("/config/../session.json", "/data/queue.key", str(secret)):
                value["hooks"]["builds"]["secret_file"] = unsafe
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    load_configuration(path)

    def test_missing_secret_and_bad_fingerprint_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            path = folder / "bot.json"
            value = {"homeserver": "http://synapse:8008", "hooks": {}, "trusted_devices": {"@alice:test": {"DEVICE": "auto-trust"}}}
            path.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                load_configuration(path)

    def test_restart_cannot_reroute_queued_content_and_revocation_erases_pending_ciphertext(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'outbox.sqlite'
            db = sqlite3.connect(path)
            db.executescript("CREATE TABLE hook_destinations(hook TEXT PRIMARY KEY,room TEXT NOT NULL); CREATE TABLE deliveries(hook TEXT,status TEXT,payload BLOB,nonce BLOB,tag BLOB);")
            config = {'hooks': {'builds': {'room_id': '!original:test'}}}
            persist_destinations(db, config)
            db.execute("INSERT INTO deliveries VALUES('builds','pending',?,?,?)", (b'encrypted-private-content', b'nonce', b'tag'))
            db.commit()
            db.close()
            db = sqlite3.connect(path)
            with self.assertRaises(RuntimeError):
                persist_destinations(db, {'hooks': {'builds': {'room_id': '!different:test'}}})
            cancel_unconfigured(db, {})
            self.assertEqual(db.execute('SELECT status,payload,nonce,tag FROM deliveries').fetchone(), ('cancelled', None, None, None))
            db.close()


if __name__ == "__main__":
    unittest.main()
