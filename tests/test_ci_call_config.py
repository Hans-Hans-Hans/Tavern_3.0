"""CI boundary and restart proof using the actual production provisioner."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import yaml

ROOT = Path(__file__).resolve().parents[1]


def module(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


ci = module('ci_call_config', 'scripts/ci-call-config.py')
provision = module('ci_actual_provision', 'docker/init/provision.py')


class CiCallConfigTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.environment = {**ci.EXPECTED, 'COMPOSE_PROFILES': 'operations,calls,integrations'}

    def prepare(self, environment=None, provisioner=None):
        with patch.object(ci, 'STATE_ROOT', self.root), patch.object(ci.sys, 'platform', 'linux'):
            ci.prepare(self.root, self.environment if environment is None else environment, provisioner or provision.provision)

    def test_guards_reject_wrong_environment_or_root_before_provisioning(self):
        for name in ci.EXPECTED:
            with self.subTest(name=name):
                called = Mock()
                with self.assertRaisesRegex(RuntimeError, 'exact isolated'):
                    self.prepare({**self.environment, name: 'wrong'}, called)
                called.assert_not_called()
        called = Mock()
        with self.assertRaisesRegex(RuntimeError, 'exact isolated'):
            self.prepare({**self.environment, 'COMPOSE_PROFILES': 'operations,integrations'}, called)
        called.assert_not_called()
        with patch.object(ci.sys, 'platform', 'linux'), self.assertRaises(RuntimeError):
            ci.prepare(self.root, self.environment, called)
        called.assert_not_called()

    def test_actual_provisioning_and_restart_keep_identity_and_original_call_config(self):
        self.prepare()
        original = (self.root / 'calls/livekit.yaml').read_bytes()
        derived = (self.root / 'calls/livekit.ci.yaml').read_bytes()
        config = json.loads(derived)
        self.assertEqual(json.loads(original)['rtc']['node_ip'], ci.EXPECTED['PUBLIC_IP'])
        self.assertEqual(config['rtc']['node_ip'], '172.30.239.2')
        self.assertFalse(config['rtc']['use_external_ip'])
        self.assertEqual(config['rtc']['stun_servers'], [])
        self.assertEqual(config['rtc']['turn_servers'], [])
        self.assertEqual(config['rtc']['ips'], {'includes': ['172.30.239.2/32']})
        self.assertIs(config['rtc']['enable_loopback_candidate'], False)
        self.assertEqual(config['rtc']['tcp_port'], 0)
        self.assertEqual(config['keys'], json.loads(original)['keys'])
        self.assertNotIn('node_ip_auto_generated', config['rtc'])  # Go-only field is not a YAML option.
        home = yaml.safe_load((self.root / 'synapse/homeserver.yaml').read_bytes())
        native = next(item for item in home['modules'] if item['module'] == 'tavern_policy.TavernPolicy')
        self.assertIs(native['config']['audio_moderation_enabled'], True)
        identity = home['registration_shared_secret']
        self.prepare()
        self.assertEqual((self.root / 'calls/livekit.yaml').read_bytes(), original)
        self.assertEqual((self.root / 'calls/livekit.ci.yaml').read_bytes(), derived)
        self.assertEqual(yaml.safe_load((self.root / 'synapse/homeserver.yaml').read_bytes())['registration_shared_secret'], identity)

    def test_invalid_existing_generated_credentials_never_create_an_override(self):
        self.prepare()
        target = self.root / 'calls/livekit.ci.yaml'
        before = target.read_bytes()
        config = json.loads((self.root / 'calls/livekit.yaml').read_bytes())
        config['keys'] = {'another-key': 'different-secret'}
        (self.root / 'calls/livekit.yaml').write_text(json.dumps(config))
        with self.assertRaises(provision.ConfigurationError):
            self.prepare()
        self.assertEqual(target.read_bytes(), before)

    def test_direct_call_derivation_uses_owned_bridge_without_rewriting_production_turn_or_synapse(self):
        self.prepare()
        originals = {name: (self.root / name).read_bytes() for name in ('calls/turnserver.conf', 'synapse/homeserver.yaml')}
        native = yaml.safe_load((self.root / 'synapse/homeserver.ci.yaml').read_bytes())
        source = yaml.safe_load(originals['synapse/homeserver.yaml'])
        self.assertEqual(native['turn_uris'], ['turn:172.30.239.3:3478?transport=udp', 'turn:172.30.239.3:3478?transport=tcp'])
        self.assertEqual(native['rc_invites']['per_user'], {'per_second': 0.003, 'burst_count': 50})
        self.assertNotIn('rc_invites', source)
        self.assertTrue(native['turn_shared_secret'] == source['turn_shared_secret'])
        turn = (self.root / 'calls/turnserver.ci.conf').read_text().splitlines()
        self.assertEqual([line for line in turn if line.startswith('external-ip=')], ['external-ip=172.30.239.3'])
        self.assertTrue('static-auth-secret=' + source['turn_shared_secret'] in turn)
        self.prepare()
        self.assertTrue(all((self.root / name).read_bytes() == value for name, value in originals.items()))

    @unittest.skipIf(__import__('os').name == 'nt', 'Windows symlink privilege differs; Linux CI runs this guard')
    def test_rejects_symlink_override_before_provisioning(self):
        calls = self.root / 'calls'; calls.mkdir()
        outside = self.root / 'untouched'; outside.write_text('unchanged')
        (calls / 'livekit.ci.yaml').symlink_to(outside)
        called = Mock()
        with self.assertRaisesRegex(RuntimeError, 'symbolic link'):
            self.prepare(provisioner=called)
        called.assert_not_called()
        self.assertEqual(outside.read_text(), 'unchanged')


if __name__ == '__main__':
    unittest.main()
