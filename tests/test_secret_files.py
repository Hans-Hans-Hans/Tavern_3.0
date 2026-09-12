import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from api.secret_files import smtp_password_file
from api.server import Config, Service


class SMTPFileTests(unittest.TestCase):
    def test_one_line_ending_only_is_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'password'
            for raw, expected in ((b' secret \n', ' secret '), (b'secret\r\n', 'secret'),
                                  (b'secret\n\n', 'secret\n'), (b'secret', 'secret'), (b'', '')):
                with self.subTest(raw=raw), patch.dict(os.environ, {'SMTP_PASSWORD_FILE': str(path)}):
                    path.write_bytes(raw)
                    self.assertEqual(smtp_password_file(), expected)

    def test_invalid_files_fail_without_disclosing_contents(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'password'
            with patch.dict(os.environ, {'SMTP_PASSWORD_FILE': str(path), 'SMTP_PASSWORD': 'legacy-secret'}):
                for raw in (None, b'private-secret\xff', b's' * 65537):
                    if raw is not None:
                        path.write_bytes(raw)
                    with self.assertRaisesRegex(ValueError, 'SMTP_PASSWORD_FILE') as caught:
                        smtp_password_file()
                    self.assertNotIn('private-secret', str(caught.exception))
                    self.assertNotIn('legacy-secret', str(caught.exception))

    def test_file_overrides_legacy_and_saved_settings_including_empty_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'password'
            for raw in (b'file-secret\n', b''):
                path.write_bytes(raw)
                with patch.dict(os.environ, {'SMTP_PASSWORD_FILE': str(path), 'SMTP_PASSWORD': 'legacy-secret'}):
                    service = Service(Config(public_url='https://chat.example.test', data_dir=root / ('full' if raw else 'empty')))
                    try:
                        service.store.set('smtp', {'password': 'saved-secret'})
                        self.assertEqual(service.smtp()['password'], raw.decode().removesuffix('\n'))
                        self.assertEqual(service.smtp(reveal=False)['passwordConfigured'], bool(raw))
                        self.assertNotIn('password', service.smtp(reveal=False))
                    finally:
                        service.store.db.close()

    def test_legacy_configuration_and_admin_override_still_work(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'SMTP_PASSWORD_FILE': '', 'SMTP_PASSWORD': 'legacy-secret'}):
            service = Service(Config(public_url='https://chat.example.test', data_dir=Path(folder)))
            try:
                self.assertIsNone(smtp_password_file())
                self.assertEqual(service.smtp()['password'], 'legacy-secret')
                service.store.set('smtp', {'password': 'saved-secret'})
                self.assertEqual(service.smtp()['password'], 'saved-secret')
            finally:
                service.store.db.close()

    def test_unconfigured_password_is_empty(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'SMTP_PASSWORD_FILE': '', 'SMTP_PASSWORD': ''}):
            service = Service(Config(public_url='https://chat.example.test', data_dir=Path(folder)))
            try:
                self.assertEqual(service.smtp()['password'], '')
                self.assertFalse(service.smtp(reveal=False)['passwordConfigured'])
            finally:
                service.store.db.close()
