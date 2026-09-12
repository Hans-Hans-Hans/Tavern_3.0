import base64
from pathlib import Path
import tempfile
import time
import unittest

from api.security import client_address, email_address, network_list, password_error, totp, verify_totp, uia_password_challenge
from api.server import APIError, Config, Service, Store


class SecurityPrimitivesTests(unittest.TestCase):
    def test_totp_rfc6238_vector_and_replay(self):
        secret = base64.b32encode(b"12345678901234567890").decode()
        self.assertEqual(totp(secret, 1), "287082")
        self.assertEqual(verify_totp(secret, "287082", now=59), 1)
        self.assertIsNone(verify_totp(secret, "287082", last_counter=1, now=59))
        self.assertIsNone(verify_totp(secret, "000000", now=59))

    def test_forwarded_networks_fail_closed(self):
        self.assertEqual(client_address('172.23.0.3', None, network_list('')), '172.23.0.3')
        with self.assertRaises(ValueError):
            client_address('172.23.0.3', '127.0.0.1', network_list(''))
        trusted = network_list("172.23.0.0/24,10.10.30.80/32")
        self.assertEqual(client_address("172.23.0.3", "10.10.20.9, 10.10.30.80", trusted), "10.10.20.9")
        self.assertEqual(client_address("172.23.0.3", "10.1.2.3, 203.0.113.3, 10.10.30.80", trusted), "203.0.113.3")
        with self.assertRaises(ValueError):
            client_address("203.0.113.3", "127.0.0.1", trusted)
        with self.assertRaises(ValueError):
            client_address("172.23.0.3", "not-an-address", trusted)

    def test_password_and_email_validation(self):
        self.assertIsNone(password_error("A long passphrase!", "A long passphrase!"))
        self.assertTrue(password_error("admin"))
        self.assertTrue(password_error("A long passphrase!", "other"))
        self.assertEqual(email_address(" Alice@Example.COM "), "alice@example.com")
        for address in ("no-at-sign", "alice@example.com\r\nBcc:other@example.com", None):
            with self.assertRaises(ValueError):
                email_address(address)

    def test_uia_does_not_downgrade_mfa(self):
        self.assertTrue(uia_password_challenge({"session": "S", "flows": [{"stages": ["m.login.password"]}]}))
        self.assertFalse(uia_password_challenge({"session": "S", "flows": [{"stages": ["m.login.password", "m.login.totp"]}]}))
        self.assertFalse(uia_password_challenge({"flows": [{"stages": ["m.login.password"]}]}))

    def test_encrypted_storage_challenge_attempts_and_persistence(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder))
            store.set("secret", {"token": "should-never-be-plaintext"})
            challenge_id = store.challenge("email", {"email": "alice@example.com"}, code="123456")
            for _ in range(5):
                challenge = store.read_challenge(challenge_id, "email")
                with self.assertRaises(APIError):
                    store.verify_code(challenge, "wrong")
            with self.assertRaises(APIError):
                store.read_challenge(challenge_id, "email")
            store.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.assertNotIn(b"should-never-be-plaintext", (Path(folder) / "tavern.sqlite3").read_bytes())
            store.db.close()
            reopened = Store(Path(folder))
            self.assertEqual(reopened.get("secret"), {"token": "should-never-be-plaintext"})
            reopened.db.close()

    def test_rate_limit_enforced(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder))
            store.rate("user", 2)
            store.rate("user", 2)
            with self.assertRaises(APIError) as caught:
                store.rate("user", 2)
            self.assertEqual(caught.exception.status, 429)
            store.db.close()

    def test_upgrade_retires_old_totp_setup_once_without_touching_authenticators(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Config(public_url='https://chat.example.test', data_dir=Path(folder))
            store = Store(config.data_dir)
            store.db.execute('INSERT INTO accounts(user_id,created) VALUES(?,?)', ('@alice:test', time.time()))
            store.db.execute('UPDATE accounts SET totp=? WHERE user_id=?', (store.seal('existing-factor'), '@alice:test'))
            old = store.challenge('totp', {'password': 'old-encrypted-password'}, '@alice:test')
            unrelated = store.challenge('email', {'email': 'alice@example.test'}, '@alice:test')
            store.db.close()
            service = Service(config)
            self.assertIsNone(service.store.db.execute('SELECT 1 FROM challenges WHERE id=?', (old,)).fetchone())
            self.assertEqual(service.store.open(service.store.account('@alice:test')['totp']), 'existing-factor')
            self.assertTrue(service.store.read_challenge(unrelated, 'email'))
            fresh = service.store.challenge('totp', {'purpose': 'totp-enrollment', 'version': 1}, '@alice:test')
            service.store.db.close()
            reopened = Service(config)
            self.assertEqual(reopened.store.read_challenge(fresh, 'totp')['payload']['version'], 1)
            reopened.store.db.close()


if __name__ == "__main__":
    unittest.main()
