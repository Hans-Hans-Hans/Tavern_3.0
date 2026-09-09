"""Exercise the container's flat API imports with a separate deployed policy tree."""
from pathlib import Path
import os
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FlatPolicyLoadingTests(unittest.TestCase):
    def test_flat_api_routes_and_deployed_native_policy_can_coexist(self):
        program = r'''
from pathlib import Path
import shutil, sys, tempfile
source = Path(sys.argv[1])
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    app_dir, modules = root / 'app', root / 'synapse' / 'tavern_modules'
    app_dir.mkdir(); modules.mkdir(parents=True)
    for origin, destination in ((source / 'api', app_dir), (source / 'synapse_modules', modules)):
        for item in origin.glob('*.py'): shutil.copyfile(item, destination / item.name)
    # Provisioning preserves old module files in existing volumes. They must
    # not shadow the distinct new native import or the API's companion module.
    shutil.copyfile(modules / 'server_account_eligibility.py', modules / 'server_eligibility.py')
    sys.path = [str(app_dir)] + [entry for entry in sys.path if entry and Path(entry).resolve() != source]
    import server
    app = server.create_app(server.Config(public_url='https://chat.example.test', data_dir=root / 'data',
        synapse_config=root / 'synapse' / 'homeserver.yaml', bootstrap_marker=root / 'synapse' / 'bootstrap'))
    try:
        from room_authority import policy_model
        model = policy_model(app['service'])
        assert model.ELIGIBILITY == 'io.tavern.server.eligibility'
        assert model.SYSTEM_MESSAGES == 'io.tavern.server.system_messages'
        assert model.ServerEligibilityPolicy.__module__ != 'server_eligibility'
        assert model.SystemMessagesPolicy.__module__ != 'system_messages'
        assert any(route.resource.canonical == '/api/internal/system-events' for route in app.router.routes())
    finally:
        app['service'].store.db.close()
'''
        environment = {**os.environ, 'INTEGRATIONS_ENABLED': 'false', 'OPERATIONS_ENABLED': 'false', 'WEB_PUSH_ENABLED': 'false'}
        result = subprocess.run([sys.executable, '-I', '-c', program, str(ROOT)], cwd=ROOT / 'api',
                                env=environment, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
