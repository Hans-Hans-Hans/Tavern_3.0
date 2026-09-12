"""Legacy call migration preserves credentials and permits nonroot runtime reads."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tests.test_compose_provision import provision


ROOT = Path(__file__).resolve().parents[1]
POSIX = os.name == 'posix'
from tests.fixtures.legacy_call_state import write_legacy_calls


class CallConfigPermissionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o755)
        self.original_umask = os.umask(0o077)
        self.addCleanup(os.umask, self.original_umask)
        self.env = {'TAVERN_DOMAIN': 'chat.example.test'}
        provision.provision(self.root, self.env)
        # Use historical artifact bytes, never execute an unsupported helper.
        (self.root / 'calls').chmod(0o700)
        write_legacy_calls(self.root)
        self.calls = self.root / 'calls'
        # An operator's additional private secret must not be widened either.
        (self.calls / 'turn_secret').write_text('preserve-private-turn-secret\n')
        (self.calls / 'operator-only').write_text('preserve-private-notes\n')

    def initialize(self):
        provision.provision(self.root, {**self.env, 'CALLS_ENABLED': 'true', 'COMPOSE_PROFILES': 'calls',
                                       'TURN_DOMAIN': 'turn.example.test', 'PUBLIC_IP': '8.8.8.8'})

    def snapshot(self):
        return {path.name: path.read_bytes() for path in self.calls.iterdir()}

    def test_actual_legacy_migration_and_restart_preserve_config_and_credentials(self):
        before = self.snapshot()
        self.assertNotIn('livekit_key', before)
        config = json.loads(before['livekit.yaml'])
        self.initialize()
        for name, data in before.items():
            self.assertEqual((self.calls / name).read_bytes(), data)
        self.assertEqual(config['keys'], {(self.calls / 'livekit_key').read_text().strip():
                                         (self.calls / 'livekit_secret').read_text().strip()})
        migrated = self.snapshot()
        self.initialize()
        self.assertEqual(self.snapshot(), migrated)

    @unittest.skipUnless(POSIX, 'POSIX mode bits are unavailable on Windows')
    def test_fresh_and_existing_operations_secret_modes_preserve_bytes(self):
        settings = {**self.env, 'OPERATIONS_ENABLED': 'true', 'COMPOSE_PROFILES': 'operations'}
        provision.provision(self.root, settings)
        token = self.root / 'operations-secret/token'
        original = token.read_bytes()
        token.chmod(0o644)
        token.parent.chmod(0o755)
        provision.provision(self.root, settings)
        self.assertEqual(token.read_bytes(), original)
        self.assertEqual(stat.S_IMODE(token.stat().st_mode), 0o640)
        self.assertEqual(stat.S_IMODE(token.parent.stat().st_mode), 0o750)
        if os.geteuid() == 0:
            self.assertEqual((token.stat().st_uid, token.stat().st_gid), (0, 10003))
            self.assertEqual(token.parent.stat().st_gid, 10003)

    @unittest.skipUnless(POSIX, 'POSIX mode bits are unavailable on Windows')
    def test_repairs_only_runtime_files_under_restrictive_umask_and_existing_secret_modes(self):
        self.assertEqual(stat.S_IMODE(self.calls.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.calls / 'livekit.yaml').stat().st_mode), 0o600)
        private = ('jwt.env', 'turn_secret', 'turnserver.conf', 'homeserver.before-calls.json', 'operator-only')
        protected = {name: ((self.calls / name).read_bytes(), stat.S_IMODE((self.calls / name).stat().st_mode))
                     for name in private}
        self.initialize()
        for attempt in range(2):
            if attempt:
                # Also repair an interrupted/manual migration with existing keys.
                self.calls.chmod(0o700)
                for name in ('livekit.yaml', 'livekit_key', 'livekit_secret'):
                    (self.calls / name).chmod(0o600)
                self.initialize()
            self.assertEqual(stat.S_IMODE(self.calls.stat().st_mode), 0o750)
            for name in ('livekit.yaml', 'livekit_key', 'livekit_secret'):
                self.assertEqual(stat.S_IMODE((self.calls / name).stat().st_mode), 0o640)
            for name, (data, mode) in protected.items():
                self.assertEqual((self.calls / name).read_bytes(), data)
                self.assertEqual(stat.S_IMODE((self.calls / name).stat().st_mode), mode)

    def reader(self, allowed, api_identity=False):
        app = self.root / 'app'
        app.mkdir(exist_ok=True)
        app.chmod(0o755)
        for source in (ROOT / 'api').glob('*.py'):
            target = app / source.name
            shutil.copyfile(source, target)
            target.chmod(0o644)
        program = r'''
import json, os, sys
from pathlib import Path
root, allowed, identity = Path(sys.argv[1]), sys.argv[2] == 'true', sys.argv[3]
assert os.geteuid() == 10001 and os.getegid() == 10001
assert os.getgroups() == ([991,10002,10003] if identity == 'api' else [10002])
try:
    config = json.loads((root / 'calls/livekit.yaml').read_bytes())
except PermissionError:
    assert not allowed
else:
    assert allowed
    assert config['port'] == 7880 and config['room']['auto_create'] is False
    if identity == 'api':
        sys.path.insert(0, str(root / 'app'))
        os.environ['CALLS_ENABLED'] = 'true'
        os.environ['CALL_CONFIG_DIR'] = str(root / 'calls')
        os.environ['RTC_AUTH_IMAGE'] = 'ghcr.io/element-hq/lk-jwt-service:0.6.0'
        from call_moderation import CallModerator
        key, secret = CallModerator(None).credentials()
        assert config['keys'] == {key: secret}
for name in ('jwt.env', 'turn_secret', 'operator-only'):
    try:
        (root / 'calls' / name).read_bytes()
    except PermissionError:
        pass
    else:
        raise AssertionError('Private sidecar became readable')
'''
        def identity():
            os.setgroups([991,10002,10003] if api_identity else [10002])
            os.setgid(10001)
            os.setuid(10001)
        result = subprocess.run([sys.executable, '-B', '-I', '-c', program, str(self.root),
                                 str(allowed).lower(), 'api' if api_identity else 'sfu'],
                                cwd=self.root, capture_output=True, text=True, timeout=30, preexec_fn=identity)
        # Credentials remain inside the child. Its successful output is empty.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')

    @unittest.skipUnless(POSIX and getattr(os, 'geteuid', lambda: -1)() == 0,
                         'Exact Docker UID checks require a root Linux test container')
    def test_actual_sfu_and_api_identities_read_repaired_legacy_runtime_files_only(self):
        self.assertEqual((self.calls / 'livekit.yaml').stat().st_uid, 0)
        self.reader(False)
        self.initialize()
        self.reader(True)
        self.reader(True, api_identity=True)
        for name in ('livekit.yaml', 'livekit_key', 'livekit_secret'):
            (self.calls / name).chmod(0o600)
        self.initialize()
        self.reader(True)
        self.reader(True, api_identity=True)


if __name__ == '__main__':
    unittest.main()
