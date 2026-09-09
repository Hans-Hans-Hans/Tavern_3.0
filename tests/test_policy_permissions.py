"""Real POSIX policy access, including the API's Docker identity when root is available."""
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

from tests.test_compose_provision import provision


ROOT = Path(__file__).resolve().parents[1]
POSIX = os.name == 'posix'


@unittest.skipUnless(POSIX, 'POSIX ownership and directory permissions are unavailable on Windows')
class PolicyPermissionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o755)
        self.original_umask = os.umask(0o077)
        self.addCleanup(os.umask, self.original_umask)
        self.env = {'TAVERN_DOMAIN': 'chat.example.test'}

    def initialize(self):
        provision.provision(self.root, self.env)
        return self.root / 'synapse' / 'tavern_modules'

    def test_restrictive_umask_and_existing_tree_preserve_group_read_without_widening_secrets(self):
        modules = self.initialize()
        self.assertEqual(stat.S_IMODE(modules.stat().st_mode), 0o750)
        files = ('homeserver.yaml', 'tavern-privacy.key', 'tavern-bootstrap-allowed')
        before = {name: ((self.root / 'synapse' / name).read_bytes(),
                         stat.S_IMODE((self.root / 'synapse' / name).stat().st_mode)) for name in files}
        self.assertTrue(all(mode == 0o640 for _, mode in before.values()))
        self.assertTrue(all(stat.S_IMODE(item.stat().st_mode) == 0o640 for item in modules.glob('*.py')))
        # Re-running the ordinary initializer repairs the affected old directory.
        modules.chmod(0o700)
        self.initialize()
        self.assertEqual(stat.S_IMODE(modules.stat().st_mode), 0o750)
        for name, (data, mode) in before.items():
            path = self.root / 'synapse' / name
            self.assertEqual(path.read_bytes(), data)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), mode)

    def reader(self, expected, api_identity=False):
        app = self.root / 'app'
        app.mkdir(exist_ok=True)
        app.chmod(0o755)
        for source in (ROOT / 'api').glob('*.py'):
            destination = app / source.name
            shutil.copyfile(source, destination)
            destination.chmod(0o644)
        program = r'''
import os, sys
from pathlib import Path
from types import SimpleNamespace
root, expected, identity = Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
if identity == 'api':
    assert os.geteuid() == 10001 and os.getegid() == 10001 and os.getgroups() == [991]
sys.path.insert(0, str(root / 'app'))
from room_authority import policy_model
from server import APIError
service = SimpleNamespace(config=SimpleNamespace(synapse_config=root / 'synapse' / 'homeserver.yaml'))
try:
    model = policy_model(service)
except APIError as error:
    assert expected == error.status == 503
    assert str(root) not in str(error)
else:
    assert expected == 200
    assert Path(model.__file__).parent == root / 'synapse' / 'tavern_modules'
    actor = '@owner:chat.example.test'
    event = SimpleNamespace(sender=actor, state_key='', content={
        'version': 1, 'enabled': False, 'channelId': '', 'hookId': '',
        'joins': True, 'leaves': False, 'io.tavern.previous_event': None})
    state = {
        ('m.room.create', ''): SimpleNamespace(sender=actor, content={'type':'m.space', 'm.federate':False}),
        ('m.room.member', actor): SimpleNamespace(content={'membership':'join'})}
    checker = model.SystemMessagesPolicy({}, None, model)
    assert checker.may_configure(event, state)
    state[('m.room.member', actor)].content = {'membership':'leave'}
    assert not checker.may_configure(event, state)
'''
        def identity():
            os.setgroups([991])
            os.setgid(10001)
            os.setuid(10001)
        result = subprocess.run([sys.executable, '-B', '-I', '-c', program, str(self.root), str(expected),
                                 'api' if api_identity else 'current'], cwd=self.root,
                                capture_output=True, text=True, timeout=30,
                                preexec_fn=identity if api_identity else None)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipIf(POSIX and os.geteuid() == 0, 'Root bypasses mode bits; use the dedicated dropped-identity test')
    def test_unreadable_deployed_directory_returns_503_and_recovers_without_repository_fallback(self):
        modules = self.initialize()
        modules.chmod(0o000)
        try:
            self.reader(503)
        finally:
            modules.chmod(0o750)
        self.reader(200)

    @unittest.skipUnless(POSIX and os.geteuid() == 0, 'The exact Docker UID/group check requires a root test container')
    def test_actual_api_uid_uses_synapse_group_to_load_and_authorize_after_existing_tree_repair(self):
        modules = self.initialize()
        self.assertEqual((modules.stat().st_uid, modules.stat().st_gid), (991, 991))
        self.reader(200, api_identity=True)
        modules.chmod(0o700)
        self.reader(503, api_identity=True)
        self.initialize()
        self.reader(200, api_identity=True)


if __name__ == '__main__':
    unittest.main()
