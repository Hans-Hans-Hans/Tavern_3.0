"""Configuration checks; no Docker daemon, network, or real accounts required."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PREPARE = Path(__file__).resolve().parents[1] / 'docker/prepare-npm.py'

class DeploymentConfiguration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'Dockerfile').touch()
        (self.source / 'compose.yaml').touch()
        self.data = self.root / 'private-data'

    def configure(self, domain='chat.example.test', data=None):
        # The tag here is syntax-test input; no image is fetched or deployed.
        return subprocess.run([sys.executable, str(PREPARE), '--domain', domain,
            '--synapse-image', 'matrixdotorg/synapse:v1.2.3', '--source-dir', str(self.source),
            '--data-dir', str(data or self.data)], capture_output=True, text=True)

    @unittest.skipIf(os.name == 'nt', 'Legacy host provisioner requires Linux paths and POSIX file permissions; tested in Linux CI.')
    def test_private_defaults_and_no_secret_in_public_environment(self):
        result = self.configure()
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads((self.data / 'synapse/homeserver.yaml').read_text())
        password_file = self.data / 'secrets/db_password'
        password = password_file.read_text().strip()
        self.assertGreater(len(password), 40)
        self.assertEqual(config['database']['args']['password'], password)
        self.assertNotIn(password, (self.source / '.env').read_text())
        self.assertEqual(password_file.stat().st_mode & 0o777, 0o600)
        self.assertFalse(config['enable_registration'])
        self.assertFalse(config['allow_guest_access'])
        self.assertFalse(config['report_stats'])
        self.assertEqual(config['federation_domain_whitelist'], [])
        self.assertEqual(config['listeners'][0]['resources'][0]['names'], ['client'])
        original = (self.data / 'synapse/homeserver.yaml').read_bytes()
        self.assertNotEqual(self.configure().returncode, 0)
        self.assertEqual((self.data / 'synapse/homeserver.yaml').read_bytes(), original)

    def test_refuses_secrets_inside_docker_build_context(self):
        self.assertNotEqual(self.configure(data=self.source / 'data').returncode, 0)
        self.assertFalse((self.source / 'data').exists())

    def test_rejects_hostname_injection_before_writing_files(self):
        for domain in ['https://chat.example.test', 'chat.example.test;bad', '-chat.example.test', 'chat..example.test']:
            with self.subTest(domain=domain):
                self.assertNotEqual(self.configure(domain=domain).returncode, 0)
                self.assertFalse(self.data.exists())

    @unittest.skipIf(os.name == 'nt', 'Legacy host provisioner requires Linux paths and POSIX file permissions; tested in Linux CI.')
    def test_calls_configuration_preserves_identity_and_private_defaults(self):
        self.assertEqual(self.configure().returncode,0)
        before=json.loads((self.data/'synapse/homeserver.yaml').read_text())
        script=PREPARE.parent/'prepare-calls.py'
        command=[sys.executable,str(script),'--data-dir',str(self.data),'--turn-domain','turn.example.test','--public-ip','8.8.8.8']
        result=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        config=json.loads((self.data/'synapse/homeserver.yaml').read_text())
        self.assertEqual(config['server_name'],before['server_name'])
        self.assertEqual(config['database'],before['database'])
        self.assertFalse(config['enable_registration'])
        self.assertEqual(config['federation_domain_whitelist'],[])
        self.assertEqual(config['listeners'][0]['resources'][0]['names'],['client','openid'])
        self.assertIn('static-auth-secret='+config['turn_shared_secret'],(self.data/'calls/turnserver.conf').read_text())
        self.assertEqual((self.data/'calls/jwt.env').stat().st_mode&0o777,0o600)
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

if __name__ == '__main__':
    unittest.main()
