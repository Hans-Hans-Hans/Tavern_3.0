import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ScriptEntrypointTests(unittest.TestCase):
    def test_container_entrypoint_shares_api_exception_type_with_route_modules(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temporary:
            environment = {**os.environ, "TAVERN_PUBLIC_URL": "https://tavern.example.com", "API_DATA_DIR": temporary, "INTEGRATIONS_ENABLED": "false"}
            program = """
import runpy,sys
from unittest.mock import patch
sys.path.insert(0,'api')
def inspect(app,**kwargs):
    import integrations_admin,admin_resources,community_api,invitation_privacy,admin_users,server
    expected=app.middlewares[0].__globals__['APIError']
    assert integrations_admin.APIError is expected
    assert admin_resources.APIError is expected
    assert community_api.APIError is expected
    assert invitation_privacy.APIError is expected
    assert admin_users.APIError is expected
    assert server.APIError is expected
    app['service'].store.db.close()
with patch('aiohttp.web.run_app',inspect):
    runpy.run_path('api/server.py',run_name='__main__')
"""
            completed = subprocess.run([sys.executable, "-c", program], cwd=root, env=environment, capture_output=True, text=True, timeout=10)
            self.assertEqual(completed.returncode, 0, completed.stderr)


if __name__ == "__main__":
    unittest.main()
