import json
from pathlib import Path
import tempfile
import sqlite3
import unittest

from integrations.configuration import cancel_unconfigured, load_configuration, message_content, persist_destinations


class BotConfigurationTests(unittest.TestCase):
    def test_legacy_hooks_and_optional_metadata_share_the_same_secret_and_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            (folder / 'hook.hmac').write_text('x' * 48)
            path = folder / 'bot.json'
            hook = {'room_id': '!room:test', 'allowed_users': ['@bot:test'], 'secret_file': '/config/hook.hmac'}
            value = {'homeserver': 'http://synapse:8008', 'hooks': {'builds': hook}}
            path.write_text(json.dumps(value))
            legacy, keys, previous = load_configuration(path)
            self.assertEqual(message_content('builds', legacy['hooks']['builds'], 'Private result'), {
                'msgtype': 'm.notice', 'body': 'Private result',
                'io.tavern.webhook': {'id': 'builds', 'name': 'builds', 'avatar_url': ''},
            })
            hook.update(name='Nightly builds', avatar_url='mxc://media.example/approved_avatar', enabled=False, created_by='@owner:test', created_at=1789000000000)
            path.write_text(json.dumps(value))
            updated, changed_keys, revision = load_configuration(path)
            self.assertEqual(keys, changed_keys)
            self.assertNotEqual(previous, revision)
            content = message_content('builds', updated['hooks']['builds'], 'Private result')
            self.assertEqual(content['io.tavern.webhook'], {'id': 'builds', 'name': 'Nightly builds', 'avatar_url': 'mxc://media.example/approved_avatar'})
            self.assertNotIn('created_by', json.dumps(content))
            self.assertNotIn('secret', json.dumps(content))
            self.assertNotIn('sender', content)

    def test_invalid_metadata_fails_closed_even_on_disabled_hooks(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            (folder / 'hook.hmac').write_text('x' * 48)
            path = folder / 'bot.json'
            invalid = {'name': ['', ' padded ', 'line\nbreak', 'x' * 81, 12],
                       'avatar_url': ['https://example/avatar.png', 'mxc://media/id?secret=leak', 'mxc://media/../private', 'mxc://media/' + 'x' * 2048, None],
                       'enabled': ['false', 0, None], 'created_by': ['owner', '@x:test\n', 12],
                       'created_at': [-1, True, 1.5, '1789000000000', 9007199254740992]}
            for field, values in invalid.items():
                for bad in values:
                    with self.subTest(field=field, value=bad):
                        hook = {'room_id': '!room:test', 'allowed_users': ['@bot:test'], 'secret_file': '/config/hook.hmac', 'enabled': False, field: bad}
                        path.write_text(json.dumps({'homeserver': 'http://synapse:8008', 'hooks': {'builds': hook}}))
                        with self.assertRaises(ValueError):
                            load_configuration(path)

    def test_disabled_hook_erases_only_pending_payloads_and_reenable_preserves_tombstones(self):
        db = sqlite3.connect(':memory:')
        try:
            db.execute('CREATE TABLE deliveries(hook TEXT,status TEXT,payload BLOB,nonce BLOB,tag BLOB)')
            db.executemany('INSERT INTO deliveries VALUES(?,?,?,?,?)', [
                ('builds', 'pending', b'encrypted', b'nonce', b'tag'), ('other', 'pending', b'other', b'nonce', b'tag'),
                ('builds', 'sent', None, None, None),
            ])
            cancel_unconfigured(db, {'builds': {'enabled': False}, 'other': {}})
            self.assertEqual(db.execute("SELECT status,payload,nonce,tag FROM deliveries WHERE hook='builds' ORDER BY rowid").fetchall(), [('cancelled', None, None, None), ('sent', None, None, None)])
            self.assertEqual(db.execute("SELECT payload FROM deliveries WHERE hook='other'").fetchone()[0], b'other')
            cancel_unconfigured(db, {'builds': {'enabled': True}, 'other': {}})
            self.assertEqual(db.execute("SELECT status FROM deliveries WHERE hook='builds' ORDER BY rowid").fetchall(), [('cancelled',), ('sent',)])
        finally:
            db.close()

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
