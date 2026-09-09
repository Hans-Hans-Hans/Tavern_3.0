"""Backup integrity, empty-state safety, and release metadata validation."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


archive = module('state_archive', 'docker/init/state_archive.py')
operations = module('host_operations', 'scripts/operations.py')
api = module('api_operations', 'api/operations.py')


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_backup_restores_exact_state_and_refuses_overwrite(self):
        source, target = self.root / 'source', self.root / 'target'
        (source / 'synapse/media_store').mkdir(parents=True)
        (source / 'synapse/media_store/image').write_bytes(bytes(range(256)))
        (source / 'api').mkdir()
        (source / 'api/tavern.sqlite3').write_bytes(b'example private database')
        stream = io.BytesIO()
        archive.export_state(source, stream)
        stream.seek(0)
        archive.restore_state(target, stream)
        self.assertEqual((source / 'synapse/media_store/image').read_bytes(), (target / 'synapse/media_store/image').read_bytes())
        self.assertEqual((source / 'api/tavern.sqlite3').read_bytes(), (target / 'api/tavern.sqlite3').read_bytes())
        stream.seek(0)
        with self.assertRaisesRegex(ValueError, 'empty persistent volumes'):
            archive.restore_state(target, stream)

    def test_restore_refuses_existing_postgres(self):
        (self.root / 'postgres').mkdir()
        (self.root / 'postgres/PG_VERSION').write_text('17')
        with self.assertRaisesRegex(ValueError, 'empty PostgreSQL'):
            archive.restore_state(self.root, io.BytesIO())

    def test_archive_path_traversal_rejected(self):
        for name in ('/etc/passwd', '../outside', 'synapse/../../outside', 'synapse\\outside', 'postgres/config'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                archive.safe_name(name)

    def make_backup(self, corrupt=False):
        state = io.BytesIO()
        with tarfile.open(fileobj=state, mode='w:gz') as output:
            info = tarfile.TarInfo('api/settings')
            info.size = 4
            output.addfile(info, io.BytesIO(b'data'))
        (self.root / 'state.tar.gz').write_bytes(state.getvalue())
        (self.root / 'synapse.dump').write_bytes(b'database')
        manifest = {'format': 1, 'files': {name: operations.digest(self.root / name) for name in ('state.tar.gz', 'synapse.dump')}}
        if corrupt:
            (self.root / 'synapse.dump').write_bytes(b'tampered')
        (self.root / 'manifest.json').write_text(json.dumps(manifest))
        destination = self.root / 'backup.tar'
        with tarfile.open(destination, 'w') as output:
            for name in ('manifest.json', 'state.tar.gz', 'synapse.dump'):
                output.add(self.root / name, arcname=name)
        return destination

    def test_full_archive_digest_verification(self):
        backup = self.make_backup()
        destination = self.root / 'verified'
        destination.mkdir()
        self.assertEqual(operations.verify_archive(backup, destination)['format'], 1)

    def test_tampering_rejected_before_restore(self):
        backup = self.make_backup(corrupt=True)
        destination = self.root / 'verified'
        destination.mkdir()
        with self.assertRaisesRegex(ValueError, 'integrity check failed'):
            operations.verify_archive(backup, destination)


class ReleaseTests(unittest.TestCase):
    def test_only_published_semantic_versions_are_selectable(self):
        result = api.release_summary([
            {'tag_name': 'v0.5.0', 'draft': False, 'prerelease': False},
            {'tag_name': 'v0.6.0-rc.1', 'draft': False, 'prerelease': True},
            {'tag_name': 'v9.0.0', 'draft': True},
            {'tag_name': 'latest; do something', 'draft': False},
            {'tag_name': 'v0.4.0', 'draft': False}])
        self.assertEqual(result['latestStable']['version'], '0.5.0')
        self.assertEqual(result['latestPrerelease']['version'], '0.6.0-rc.1')
        self.assertTrue(result['updateAvailable'])
        self.assertEqual(result['latestStable']['url'], 'https://github.com/Hans-Hans-Hans/Tavern_3.0/releases/tag/v0.5.0')

    def test_no_release_is_not_reported_as_an_update(self):
        result = api.release_summary([])
        self.assertFalse(result['updateAvailable'])
        self.assertIsNone(result['latestStable'])


if __name__ == '__main__':
    unittest.main()
