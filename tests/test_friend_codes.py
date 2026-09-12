import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from api import friend_codes as codes


class FriendCodeTests(unittest.TestCase):
    def test_code_survives_database_reopen_and_additive_schema_setup(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'contacts.db'
            db = sqlite3.connect(path, isolation_level=None)
            codes.ensure_schema(db)
            code = codes.own_code(db, '@owner:local')
            db.close()
            db = sqlite3.connect(path, isolation_level=None)
            try:
                codes.ensure_schema(db)
                self.assertEqual(codes.own_code(db, '@owner:local'), code)
                self.assertEqual(codes.resolve_code(db, codes.normalize_code(code)), '@owner:local')
            finally:
                db.close()

    def test_human_format_is_lenient_without_accepting_extra_data(self):
        self.assertEqual(codes.normalize_code(' tav-oi23 4567-89ab '), '0123456789AB')
        self.assertEqual(codes.normalize_code('TAV123456789'), 'TAV123456789')
        for value in (None, {}, 12, '', 'A' * 11, 'A' * 13, 'TAV-' + 'A' * 80, '@owner:local', 'https://local/TAV-1234-5678-9ABC', '1234/5678/9ABC'):
            with self.subTest(value=value):
                self.assertIsNone(codes.normalize_code(value))

    def test_random_collision_cannot_reassign_someone_elses_code(self):
        db = sqlite3.connect(':memory:', isolation_level=None)
        self.addCleanup(db.close)
        codes.ensure_schema(db)
        db.execute('INSERT INTO social_friend_codes VALUES(?,?,?)', ('@first:local', 'A' * 12, 1))
        with patch.object(codes.secrets, 'choice', side_effect=list('A' * 12 + 'B' * 12)):
            self.assertEqual(codes.own_code(db, '@second:local'), codes.display_code('B' * 12))
        self.assertEqual(codes.resolve_code(db, 'A' * 12), '@first:local')
        self.assertIsNone(codes.rotate_code(db, '@second:local', codes.display_code('A' * 12)))
