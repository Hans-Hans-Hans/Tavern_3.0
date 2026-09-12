"""Exercise persistent provisioning against fresh and migrated state."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('compose_provision', ROOT / 'docker/init/provision.py')
provision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provision)


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = {'TAVERN_DOMAIN': 'chat.example.test'}

    def run_init(self, **changes):
        return provision.provision(self.root, {**self.env, **changes})

    def config(self):
        return yaml.safe_load((self.root / 'synapse/homeserver.yaml').read_text())

    def test_fresh_state_and_restart_preserve_all_credentials(self):
        self.run_init()
        before = self.config()
        self.assertFalse(before['enable_registration'])
        self.assertEqual(before['federation_domain_whitelist'], [])
        self.assertTrue((self.root / 'synapse/tavern-bootstrap-allowed').is_file())
        self.assertEqual(before['database']['args']['password'], (self.root / 'secrets/db_password').read_text().strip())
        self.assertGreater(len(before['registration_shared_secret']), 40)
        (self.root / 'synapse/server.signing.key').write_text('existing signing identity')
        self.run_init()
        self.assertEqual(before, self.config())
        self.assertEqual((self.root / 'synapse/server.signing.key').read_text(), 'existing signing identity')

    def test_existing_deployment_never_enables_bootstrap(self):
        self.run_init()
        (self.root / 'synapse/tavern-bootstrap-allowed').unlink()
        (self.root / 'synapse/homeserver.yaml').write_text(yaml.safe_dump(self.config()))
        self.run_init()
        self.assertFalse((self.root / 'synapse/tavern-bootstrap-allowed').exists())

    def test_old_upload_ceiling_migrates_once_without_changing_identity(self):
        self.run_init()
        config = self.config()
        self.assertEqual(config['max_upload_size'], '512M')
        config['max_upload_size'] = '10M'
        source = self.root / 'synapse/homeserver.yaml'
        source.write_text(yaml.safe_dump(config), encoding='utf-8')
        original = source.read_bytes()
        self.run_init()
        self.assertEqual(self.config(), {**config, 'max_upload_size': '512M'})
        backup = self.root / 'synapse/homeserver.before-upload-limit.yaml'
        self.assertEqual(backup.read_bytes(), original)
        migrated = source.read_bytes()
        self.run_init()
        self.assertEqual(source.read_bytes(), migrated)
        self.assertEqual(backup.read_bytes(), original)

    def test_custom_upload_ceiling_is_preserved(self):
        self.run_init()
        config = self.config()
        config['max_upload_size'] = '25M'
        (self.root / 'synapse/homeserver.yaml').write_text(yaml.safe_dump(config), encoding='utf-8')
        self.run_init()
        self.assertEqual(self.config(), config)

    def test_sync_cache_migration_preserves_identity_and_unrelated_cache_tuning(self):
        self.run_init()
        config = self.config()
        config['caches'] = {'sync_response_cache_duration': '2m', 'global_factor': 0.7, 'per_cache_factors': {'get_users_in_room': 2}}
        source = self.root / 'synapse/homeserver.yaml'
        source.write_text(yaml.safe_dump(config), encoding='utf-8')
        original = source.read_bytes()
        self.run_init()
        expected = {**config, 'caches': {**config['caches'], 'sync_response_cache_duration': '0s'}}
        self.assertEqual(self.config(), expected)
        backup = self.root / 'synapse/homeserver.before-sync-cache.yaml'
        self.assertEqual(backup.read_bytes(), original)
        migrated = source.read_bytes()
        self.run_init()
        self.assertEqual(source.read_bytes(), migrated)
        self.assertEqual(backup.read_bytes(), original)

    def test_new_server_does_not_replay_completed_sync_responses(self):
        self.run_init()
        self.assertEqual(self.config()['caches']['sync_response_cache_duration'], '0s')

    def test_optional_system_notice_worker_tracks_integration_profile_without_rotating_identity(self):
        self.run_init()
        def module():
            return next(item['config'] for item in self.config()['modules'] if item['module'] == 'tavern_policy.TavernPolicy')
        identity = self.config()['registration_shared_secret']
        key = (self.root / 'synapse/tavern-privacy.key').read_bytes()
        self.assertIs(module()['system_messages_enabled'], False)
        for enabled in (True, True, False):
            self.run_init(INTEGRATIONS_ENABLED=str(enabled).lower(), COMPOSE_PROFILES='integrations' if enabled else '')
            self.assertIs(module()['system_messages_enabled'], enabled)
            self.assertEqual(self.config()['registration_shared_secret'], identity)
            self.assertEqual((self.root / 'synapse/tavern-privacy.key').read_bytes(), key)
            self.assertTrue((self.root / 'synapse/tavern_modules/server_system_messages.py').is_file())
            self.assertTrue((self.root / 'synapse/tavern_modules/call_audio_policy.py').is_file())

    def test_existing_database_without_identity_is_rejected(self):
        (self.root / 'postgres').mkdir()
        (self.root / 'postgres/PG_VERSION').write_text('17')
        with self.assertRaisesRegex(provision.ConfigurationError, 'PostgreSQL data exists'):
            self.run_init()
        self.assertFalse((self.root / 'synapse/tavern-bootstrap-allowed').exists())

    def test_audio_moderation_requires_calls_and_updates_native_flag_without_rotating_keys(self):
        with self.assertRaisesRegex(provision.ConfigurationError, 'requires CALLS_ENABLED'):
            self.run_init(SFU_AUDIO_MODERATION_ENABLED='true')
        self.assertFalse((self.root / 'synapse/homeserver.yaml').exists())
        self.run_init()
        def policy():
            return next(item['config'] for item in self.config()['modules'] if item['module'] == 'tavern_policy.TavernPolicy')
        self.assertIs(policy()['audio_moderation_enabled'], False)
        identity = self.config()['registration_shared_secret']
        key = (self.root / 'synapse/tavern-privacy.key').read_bytes()
        for enabled in (True, True, False):
            self.run_init(CALLS_ENABLED='true', COMPOSE_PROFILES='calls', TURN_DOMAIN='turn.example.test',
                          PUBLIC_IP='8.8.8.8', SFU_AUDIO_MODERATION_ENABLED=str(enabled).lower())
            self.assertIs(policy()['audio_moderation_enabled'], enabled)
            self.assertEqual(self.config()['registration_shared_secret'], identity)
            self.assertEqual((self.root / 'synapse/tavern-privacy.key').read_bytes(), key)
        before = (self.root / 'synapse/homeserver.yaml').read_bytes()
        with self.assertRaises(provision.ConfigurationError):
            self.run_init(SFU_AUDIO_MODERATION_ENABLED='yes')
        self.assertEqual((self.root / 'synapse/homeserver.yaml').read_bytes(), before)

    def test_invalid_input_does_not_create_config(self):
        for changes in ({'TAVERN_DOMAIN': 'https://chat.example.test'}, {'TAVERN_DOMAIN': 'bad;host'},
                        {'TAVERN_PUBLIC_URL': 'http://chat.example.test'}, {'CALLS_ENABLED': 'yes'},
                        {'CALLS_ENABLED': 'true'}, {'COMPOSE_PROFILES': 'calls'},
                        {'INTEGRATIONS_ENABLED': 'yes'}, {'COMPOSE_PROFILES': 'integrations'}, {'INTEGRATIONS_ENABLED': 'true'},
                        {'CALLS_ENABLED': 'true', 'COMPOSE_PROFILES': 'calls', 'TURN_DOMAIN': 'turn.example.test', 'PUBLIC_IP': '192.168.1.1'}):
            with self.subTest(changes=changes), self.assertRaises(provision.ConfigurationError):
                self.run_init(**changes)
        self.assertFalse((self.root / 'synapse/homeserver.yaml').exists())

    def test_hostname_change_and_password_mismatch_are_rejected(self):
        self.run_init()
        before = (self.root / 'synapse/homeserver.yaml').read_bytes()
        with self.assertRaisesRegex(provision.ConfigurationError, 'existing Synapse server_name'):
            self.run_init(TAVERN_DOMAIN='changed.example.test')
        secret = self.root / 'secrets/db_password'
        secret.chmod(0o600)
        secret.write_text('different password')
        with self.assertRaisesRegex(provision.ConfigurationError, 'password file'):
            self.run_init()
        self.assertEqual(before, (self.root / 'synapse/homeserver.yaml').read_bytes())

    def test_calls_generate_shared_credentials_and_are_idempotent(self):
        self.run_init()
        before = self.config()
        settings = {'CALLS_ENABLED': 'true', 'COMPOSE_PROFILES': 'calls', 'TURN_DOMAIN': 'turn.example.test', 'PUBLIC_IP': '8.8.8.8'}
        self.run_init(**settings)
        config = self.config()
        livekit = json.loads((self.root / 'calls/livekit.yaml').read_text())
        self.assertEqual(before['registration_shared_secret'], config['registration_shared_secret'])
        self.assertEqual(config['turn_shared_secret'], livekit['rtc']['turn_servers'][0]['secret'])
        self.assertIn('static-auth-secret=' + config['turn_shared_secret'], (self.root / 'calls/turnserver.conf').read_text())
        self.assertFalse(config['turn_allow_guests'])
        self.assertFalse(livekit['room']['auto_create'])
        self.assertEqual(livekit['keys'][(self.root / 'calls/livekit_key').read_text().strip()], (self.root / 'calls/livekit_secret').read_text().strip())
        snapshot = {p.name: p.read_bytes() for p in (self.root / 'calls').iterdir()}
        self.run_init(**settings)
        self.assertEqual(snapshot, {p.name: p.read_bytes() for p in (self.root / 'calls').iterdir()})
        with self.assertRaisesRegex(provision.ConfigurationError, 'PUBLIC_IP differs'):
            self.run_init(**{**settings, 'PUBLIC_IP': '1.1.1.1'})
        self.assertEqual(snapshot, {p.name: p.read_bytes() for p in (self.root / 'calls').iterdir()})


class ComposeStructure(unittest.TestCase):
    def test_single_file_contains_stack_and_preserves_existing_volume_name(self):
        config = yaml.safe_load((ROOT / 'compose.yaml').read_text())
        services = config['services']
        for service in ('init', 'tavern-web', 'tavern-api', 'synapse', 'postgres', 'coturn', 'livekit', 'rtc-auth', 'integrations'):
            self.assertIn(service, services)
        self.assertIn('postgres_data', config['volumes'])
        for service in ('synapse', 'tavern-api', 'postgres', 'rtc-auth'):
            self.assertNotIn('ports', services[service])
        self.assertTrue(config['networks']['private']['internal'])
        self.assertEqual(services['coturn']['profiles'], ['calls'])
        socket_services = [name for name, service in services.items() if any('/var/run/docker.sock' in item for item in service.get('volumes', []))]
        self.assertEqual(socket_services, ['operations'])
        self.assertEqual(services['operations']['profiles'], ['operations'])
        self.assertIn('991', services['tavern-api']['group_add'])


if __name__ == '__main__':
    unittest.main()
