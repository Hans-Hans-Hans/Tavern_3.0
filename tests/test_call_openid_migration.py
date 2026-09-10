"""Upgrade existing call settings without changing any credential or media config."""
import copy
import hashlib
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import yaml

from tests.test_compose_provision import provision


class CallOpenidMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {'TAVERN_DOMAIN': 'calls.example.test', 'CALLS_ENABLED': 'true', 'COMPOSE_PROFILES': 'calls',
                    'TURN_DOMAIN': 'turn.example.test', 'PUBLIC_IP': '8.8.8.8'}
        provision.provision(self.root, self.env)
        self.path = self.root / 'synapse/homeserver.yaml'
        self.backup = self.path.with_name('homeserver.before-openid-v1.yaml')

    def config(self):
        return yaml.safe_load(self.path.read_bytes())

    def calls(self):
        return {path.name: path.read_bytes() for path in (self.root / 'calls').iterdir()}

    def legacy_config(self):
        value = self.config()
        for listener in value['listeners']:
            for resource in listener.get('resources', []):
                resource['names'] = [name for name in resource['names'] if name != 'openid']
        value['listeners'].append({'port': 9000, 'type': 'http', 'resources': [{'names': ['metrics'], 'compress': True}]})
        value['listeners'].append({'port': 8009, 'type': 'http', 'resources': [{'names': ['client'], 'compress': True}]})
        value['operator_custom_setting'] = {'retain': ['unchanged', 42]}
        self.path.write_bytes(('# Exact operator before-image\r\n' + yaml.safe_dump(value).replace('\n', '\r\n')).encode())
        return value

    def test_existing_calls_migrate_all_client_listeners_with_exact_backup_and_preserved_keys(self):
        before = self.legacy_config(); raw = self.path.read_bytes(); calls = self.calls()
        (self.root / 'synapse/server.signing.key').write_bytes(b'untouched-signing-identity')
        provision.provision(self.root, self.env)
        expected = copy.deepcopy(before)
        for listener in expected['listeners']:
            for resource in listener['resources']:
                if 'client' in resource['names']: resource['names'].append('openid')
        self.assertEqual(self.config(), expected)
        self.assertEqual(self.backup.read_bytes(), raw)
        self.assertEqual(self.calls(), calls)
        self.assertEqual((self.root / 'synapse/server.signing.key').read_bytes(), b'untouched-signing-identity')
        # A restart does not reserialize the repaired home file or backup.
        repaired = self.path.read_bytes()
        provision.provision(self.root, self.env)
        self.assertEqual(self.path.read_bytes(), repaired); self.assertEqual(self.backup.read_bytes(), raw)
        self.assertEqual(self.calls(), calls)

    def test_already_enabled_configuration_is_byte_identical_and_needs_no_backup(self):
        before, calls = self.path.read_bytes(), self.calls()
        provision.provision(self.root, self.env)
        self.assertEqual(self.path.read_bytes(), before); self.assertEqual(self.calls(), calls)
        self.assertFalse(self.backup.exists())

    def test_existing_different_backup_is_never_overwritten(self):
        self.legacy_config(); before = self.path.read_bytes()
        self.backup.write_bytes(b'older preserved backup\r\n')
        provision.provision(self.root, self.env)
        versioned = self.path.with_name('homeserver.before-openid-v1.' + hashlib.sha256(before).hexdigest() + '.yaml')
        self.assertEqual(versioned.read_bytes(), before)
        self.assertEqual(self.backup.read_bytes(), b'older preserved backup\r\n')
        backups = {path.name: path.read_bytes() for path in self.path.parent.glob('homeserver.before-openid*')}
        provision.provision(self.root, self.env)
        self.assertEqual({path.name: path.read_bytes() for path in self.path.parent.glob('homeserver.before-openid*')}, backups)

    def test_invalid_existing_call_settings_fail_before_openid_or_credential_writes(self):
        self.legacy_config(); before = self.path.read_bytes(); calls = self.calls()
        for bad in ('turn', 'ip', 'key', 'incomplete'):
            with self.subTest(bad=bad):
                for name, value in calls.items(): (self.root / 'calls' / name).write_bytes(value)
                changed_env = dict(self.env)
                if bad == 'turn': (self.root / 'calls/turnserver.conf').write_text('static-auth-secret=mismatch\n')
                if bad == 'ip': changed_env['PUBLIC_IP'] = '1.1.1.1'
                if bad == 'key':
                    (self.root / 'calls/livekit_key').unlink()
                    (self.root / 'calls/livekit_secret').write_text('mismatched-existing-secret')
                if bad == 'incomplete': (self.root / 'calls/livekit.yaml').unlink()
                invalid_snapshot = self.calls()
                with self.assertRaises(provision.ConfigurationError): provision.provision(self.root, changed_env)
                self.assertEqual(self.path.read_bytes(), before)
                self.assertEqual(self.calls(), invalid_snapshot)
                self.assertFalse(self.backup.exists())

    def test_backup_failure_preserves_home_and_every_call_file(self):
        self.legacy_config(); before, calls = self.path.read_bytes(), self.calls()
        original = provision.write_new
        def failing(path, *args, **kwargs):
            if path == self.backup: raise OSError('fixture backup unavailable')
            return original(path, *args, **kwargs)
        with patch.object(provision, 'write_new', failing), self.assertRaises(OSError):
            provision.provision(self.root, self.env)
        self.assertEqual(self.path.read_bytes(), before); self.assertEqual(self.calls(), calls)

    def test_concurrent_operator_edit_is_preserved_and_pending_file_removed(self):
        value = self.legacy_config(); before = self.path.read_bytes(); edited = before + b'# Concurrent operator edit\r\n'
        original_fsync = provision.os.fsync
        def edited_during_write(descriptor):
            original_fsync(descriptor)
            self.path.write_bytes(edited)
        with patch.object(provision.os, 'fsync', edited_during_write), self.assertRaisesRegex(provision.ConfigurationError, 'changed during OpenID'):
            provision.migrate_existing_call_openid(self.root, value, provision.client_openid_resources(value))
        self.assertEqual(self.path.read_bytes(), edited); self.assertEqual(self.backup.read_bytes(), before)
        self.assertFalse(any(path.name.startswith('tmp') for path in self.path.parent.iterdir()))

    def test_invalid_client_resource_schema_is_rejected_without_partial_mutation(self):
        for listeners in ([], [{'resources': [{'names': 'client'}]}], [{'resources': [{'names': ['client']}, {'names': None}]}]):
            value = {'listeners': listeners}; before = copy.deepcopy(value)
            with self.assertRaises(provision.ConfigurationError): provision.client_openid_resources(value)
            self.assertEqual(value, before)

    @unittest.skipUnless(os.name == 'posix', 'POSIX ownership/mode unavailable on Windows')
    def test_additive_replacement_preserves_native_config_owner_and_mode(self):
        value = self.legacy_config(); old = self.path.stat()
        provision.migrate_existing_call_openid(self.root, value, provision.client_openid_resources(value))
        current = self.path.stat()
        self.assertEqual((current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)), (old.st_uid, old.st_gid, stat.S_IMODE(old.st_mode)))
        self.assertEqual(stat.S_IMODE(self.backup.stat().st_mode), 0o640)
