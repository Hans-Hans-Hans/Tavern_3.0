"""Regression checks for credential ignores and the published-index guard."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class RepositoryHygiene(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        shutil.copy(ROOT / '.gitignore', self.root / '.gitignore')
        self.git('add', '.gitignore')

    def git(self, *args):
        return subprocess.run(['git', '-c', 'core.excludesFile=/dev/null', *args],
                              cwd=self.root, capture_output=True, check=True)

    def check(self):
        return subprocess.run([sys.executable, str(ROOT / 'scripts/check-repository.py')],
                              cwd=self.root, capture_output=True, text=True)

    def test_private_state_ignored_and_source_examples_kept(self):
        private = ['.env', '.env.production', 'calls/jwt.env', 'server.signing.key',
                   'docker/synapse/homeserver.yaml', 'tavern-data/secrets/db_password',
                   'integrations/config/bot.json', 'integrations/session.json',
                   'integrations/identity.json', 'integrations/data/crypto/crypto.db',
                   'crypto.sqlite-wal', 'crypto.sqlite3-shm', 'queue.key', 'builds.hmac',
                   'backup.pfx', '.venv/lib/private.py', 'logs/server.log',
                   'node_modules/a/index.js', 'public/element-call/index.html',
                   'releases/source.zip', '.openai/hosting.json']
        source = ['.env.example', 'calls/jwt.env.example', 'integrations/config.example.json',
                  'integrations/requirements.lock', 'package-lock.json',
                  'public/tavern-config.json', 'compose.github.full.yaml',
                  '.github/workflows/check.yml', '.editorconfig']
        for path in private + source:
            with self.subTest(path=path):
                result = subprocess.run(['git', '-c', 'core.excludesFile=/dev/null',
                                         'check-ignore', '--no-index', '-q', path], cwd=self.root)
                self.assertEqual(result.returncode, 0 if path in private else 1)

    def test_forced_private_file_is_rejected(self):
        self.assertEqual(self.check().returncode, 0)
        (self.root / '.env').write_text('LOCAL_SETTING=example\n')
        self.git('add', '-f', '.env')
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Ignored file is tracked: .env', result.stderr)

    def test_credential_in_ordinary_source_is_rejected_without_logging_it(self):
        token = 'gh' + 'p_' + 'A' * 36
        (self.root / 'example.txt').write_text(token)
        self.git('add', 'example.txt')
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Possible GitHub token', result.stderr)
        self.assertNotIn(token, result.stderr + result.stdout)


if __name__ == '__main__':
    unittest.main()
