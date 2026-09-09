"""Privilege boundary, scheduling and API checks without accessing Docker."""
import asyncio
import gzip
import io
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('operations_worker', ROOT / 'ops/server.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class FakeEngine:
    def close(self):
        pass


class WorkerPolicy(unittest.TestCase):
    def test_binary_exec_preserves_non_utf8_archive_bytes_and_ignores_stderr(self):
        payload = gzip.compress(bytes(range(256)) * 20)
        with tempfile.TemporaryDirectory() as directory:
            engine = FakeEngine()
            engine.api = Mock()
            engine.api.exec_create.return_value = {'Id': 'exact-helper-exec'}
            engine.api.exec_start.return_value = iter([(payload[:5], None), (None, b'non-secret warning'), (payload[5:], None)])
            engine.api.exec_inspect.return_value = {'ExitCode': 0}
            operator = worker.Operator(directory, 'tavern', engine)
            output = io.BytesIO()
            operator.stream_exec(Mock(id='created-helper'), ['python', '/app/state_archive.py', 'export'], output)
            self.assertEqual(output.getvalue(), payload)
            self.assertEqual(gzip.decompress(output.getvalue()), bytes(range(256)) * 20)
            engine.api.exec_start.assert_called_once_with('exact-helper-exec', stream=True, demux=True)
            operator.db.close()

    def test_failed_backup_always_restarts_paused_writers(self):
        with tempfile.TemporaryDirectory() as directory:
            operator = worker.Operator(directory, 'tavern', FakeEngine())
            events = []
            containers = {}
            for name in ('init', 'postgres', 'synapse', 'tavern-api'):
                container = Mock()
                container.status = 'exited' if name == 'init' else 'running'
                container.stop.side_effect = lambda timeout, name=name: events.append('stop:' + name)
                container.start.side_effect = lambda name=name: events.append('start:' + name)
                containers[name] = container
            with patch.object(operator, 'containers', return_value=containers), patch.object(operator, 'check'), patch.object(operator, 'exec_to_file', side_effect=ValueError('Export failed')):
                with self.assertRaisesRegex(ValueError, 'Export failed'):
                    operator.backup('a' * 32)
            self.assertEqual(events, ['stop:tavern-api', 'stop:synapse', 'start:synapse', 'start:tavern-api'])
            self.assertEqual(operator.backup_list(), [])
            operator.db.close()

    def test_source_images_cannot_be_replaced_by_automatic_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            operator = worker.Operator(directory, 'tavern', FakeEngine())
            container = Mock()
            container.attrs = {'Config': {'Image': 'tavern:local'}}
            with patch.object(operator, 'release', return_value='0.4.1'), patch.object(operator, 'containers', return_value={'tavern-web': container}), patch.object(operator, 'backup') as backup:
                with self.assertRaisesRegex(ValueError, 'official GHCR'):
                    operator.update('a' * 32, '0.4.1')
                backup.assert_not_called()
            operator.db.close()

    def test_requires_both_exact_project_and_managed_label(self):
        labels = {'com.docker.compose.project': 'tavern', 'com.docker.compose.service': 'tavern-api', 'io.tavern.managed': 'true'}
        self.assertTrue(worker.scoped_container({'Config': {'Labels': labels}}, 'tavern'))
        for changes in ({'com.docker.compose.project': 'another-app'}, {'io.tavern.managed': 'false'}, {'com.docker.compose.service': 'npm'}, {'io.tavern.rollback': 'backup'}):
            with self.subTest(changes=changes):
                self.assertFalse(worker.scoped_container({'Config': {'Labels': {**labels, **changes}}}, 'tavern'))

    def test_update_scope_excludes_database_and_unrelated_images(self):
        self.assertEqual(set(worker.UPDATE_IMAGES), {'tavern-web', 'tavern-api'})
        for version in ('latest', '../image', '1.2.3;command', 'https://example.com/image', '', None):
            with self.subTest(version=version), self.assertRaises(ValueError):
                worker.allowed_release(version)
        self.assertEqual(worker.allowed_release('0.4.2-rc.1'), '0.4.2-rc.1')
        self.assertLess(worker.version_order('0.4.2-rc.2'), worker.version_order('0.4.2-rc.10'))
        self.assertLess(worker.version_order('0.4.2-rc.10'), worker.version_order('0.4.2'))

    def test_schedules_and_retention_are_validated(self):
        self.assertEqual(worker.validate_settings({'backupEnabled': True, 'backupTime': '04:30'})['retention'], 14)
        for value in ({'backupTime': '25:00'}, {'retention': 0}, {'retention': True}, {'autoUpdateEnabled': 'true'}, {'channel': 'arbitrary'}, {'shell': 'anything'}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                worker.validate_settings(value)

    def test_archives_are_ordered_by_creation_and_paths_cannot_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            operator = worker.Operator(directory, 'tavern', FakeEngine())
            newer = Path(directory) / 'backups' / ('tavern-' + '0' * 32 + '.tar')
            older = Path(directory) / 'backups' / ('tavern-' + 'f' * 32 + '.tar')
            newer.write_bytes(b'new')
            older.write_bytes(b'old')
            os.utime(newer, (200, 200))
            os.utime(older, (100, 100))
            self.assertEqual(operator.backup_list()[0]['id'], newer.stem)
            with self.assertRaises(ValueError):
                operator.archive_path('../../config')
            operator.db.close()


class WorkerHTTP(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.secret = 'x' * 64
        self.app = worker.create_app(self.temp.name, 'tavern', FakeEngine(), self.secret)
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.temp.cleanup()

    async def test_private_requests_require_operator_secret(self):
        self.assertEqual((await self.client.get('/health')).status, 200)
        self.assertEqual((await self.client.get('/state')).status, 401)
        self.assertEqual((await self.client.get('/state', headers={'Authorization': 'Bearer incorrect'})).status, 401)
        result = await self.client.get('/state', headers={'Authorization': 'Bearer ' + self.secret})
        self.assertEqual(result.status, 200)
        self.assertTrue((await result.json())['available'])

    async def test_destructive_operations_require_exact_confirmation(self):
        headers = {'Authorization': 'Bearer ' + self.secret}
        response = await self.client.post('/updates/apply', json={'version': '0.4.1'}, headers=headers)
        self.assertEqual(response.status, 400)
        response = await self.client.post('/backups/tavern-' + 'a' * 32 + '/restore', json={'confirmation': 'yes'}, headers=headers)
        self.assertEqual(response.status, 400)

    async def test_failed_job_never_reports_success_and_history_persists(self):
        operator = self.app['operator']
        with patch.object(operator, 'backup', side_effect=ValueError('Backup failed safely.')):
            identity = await operator.submit('backup', {})
            await operator.task
        row = operator.db.execute('SELECT state,result FROM jobs WHERE id=?', (identity,)).fetchone()
        self.assertEqual(row['state'], 'failed')
        self.assertIn('Backup failed safely.', row['result'])
