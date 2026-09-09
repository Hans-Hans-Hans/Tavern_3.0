import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from ops.telemetry import Telemetry, filters, log_row, metrics
from api.operations import bounded_json


class TelemetryTests(unittest.TestCase):
    def container(self, component='tavern-api', project='tavern', managed='true', **extra):
        labels = {'com.docker.compose.project': project, 'com.docker.compose.service': component, 'io.tavern.managed': managed, **extra}
        value = Mock(name='container')
        value.name = 'tavern-' + component
        value.status = 'running'
        value.attrs = {'Config': {'Labels': labels, 'Env': ['PRIVATE_VALUE=never-return']}, 'HostConfig': {'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '10m', 'max-file': '3'}}}}
        return value

    def telemetry(self, containers):
        engine = SimpleNamespace(containers=SimpleNamespace(list=Mock(return_value=containers)))
        return Telemetry(SimpleNamespace(engine=engine, project='tavern'))

    def test_observations_exclude_unrelated_projects_services_unmanaged_and_rollback(self):
        allowed = self.container('livekit')
        observer = self.telemetry([allowed, self.container(project='another-app'), self.container(managed='false'), self.container('npm'), self.container('synapse', **{'io.tavern.rollback': 'previous'})])
        self.assertEqual(observer.inventory(), {'livekit': allowed})
        observer.operator.engine.containers.list.assert_called_once_with(all=True, filters={'label': ['com.docker.compose.project=tavern', 'io.tavern.managed=true']})

    def test_filters_reject_arbitrary_container_paths_commands_and_unbounded_queries(self):
        for query in ({'component': 'npm'}, {'component': '../postgres'}, {'command': 'exec'}, {'minutes': '1441'}, {'limit': '2001'}, {'severity': 'TRACE'}, {'search': 'x' * 121}, {'search': 'line\nnext'}):
            with self.subTest(query=query), self.assertRaises(ValueError):
                filters(query)
        self.assertEqual(filters({'component': 'synapse', 'severity': 'ERROR', 'limit': '500'})['limit'], 500)

    def test_log_rows_parse_structured_severity_strip_terminal_codes_and_mask_credentials(self):
        row = log_row('2026-09-09T00:00:00.123456789Z ' + json.dumps({'level': 'warning', 'message': '\x1b[31mFailed authorization: Bearer token-value password="words with spaces" access_token=private-value'}), 'tavern-api')
        self.assertEqual(row['severity'], 'WARN')
        self.assertEqual(row['timestamp'], '2026-09-09T00:00:00.123456789Z')
        for value in ('token-value', 'words with spaces', 'private-value', '\x1b'):
            self.assertNotIn(value, row['message'])

    def test_filtered_logs_are_scoped_bounded_and_do_not_return_container_configuration(self):
        container = self.container()
        container.logs.return_value = iter([b'2026-09-09T00:00:00Z INFO ordinary\n2026-09-09T00:00:01Z ERROR database unavailable\n'])
        result = self.telemetry([container]).read_logs(filters({'severity': 'ERROR', 'search': 'database', 'limit': '1'}))
        self.assertEqual(len(result['rows']), 1)
        self.assertEqual(result['rows'][0]['message'], 'ERROR database unavailable')
        self.assertNotIn('PRIVATE_VALUE', json.dumps(result))
        self.assertFalse(container.logs.call_args.kwargs['follow'])
        self.assertEqual(container.logs.call_args.kwargs['tail'], 1)
        self.assertTrue(result['truncated'])

    def test_invite_paths_queries_and_cookie_headers_are_masked_before_export(self):
        for text in ('GET /api/invitations/preview/private-link-token HTTP/1.1', 'GET /?invite=private-link-token&next=home', 'Cookie: sid=first-private; second=second-private'):
            row = log_row('2026-09-09T00:00:00Z ' + text, 'tavern-web')
            for secret in ('private-link-token', 'first-private', 'second-private'):
                self.assertNotIn(secret, json.dumps(row))

    def test_missing_metrics_remain_unknown_and_real_cpu_memory_samples_use_deltas(self):
        missing = metrics({})
        self.assertIsNone(missing['cpuPercent']); self.assertIsNone(missing['memoryBytes']); self.assertIsNone(missing['receivedBytes'])
        sampled = metrics({'cpu_stats': {'cpu_usage': {'total_usage': 200}, 'system_cpu_usage': 1000, 'online_cpus': 2}, 'precpu_stats': {'cpu_usage': {'total_usage': 150}, 'system_cpu_usage': 800}, 'memory_stats': {'usage': 400, 'limit': 1000, 'stats': {'inactive_file': 100}}, 'pids_stats': {'current': 3}, 'networks': {'eth0': {'rx_bytes': 50, 'tx_bytes': 20}}})
        self.assertEqual(sampled, {'cpuPercent': 50.0, 'memoryBytes': 300, 'memoryLimitBytes': 1000, 'memoryPercent': 30.0, 'pids': 3, 'receivedBytes': 50, 'sentBytes': 20})

    def test_stopped_or_unsupported_services_do_not_claim_zero_usage(self):
        container = self.container()
        container.status = 'exited'
        result = self.telemetry([container]).sample('tavern-api', container)
        self.assertFalse(result['available']); container.stats.assert_not_called()
        container.status = 'running'; container.stats.side_effect = RuntimeError('Unsupported')
        self.assertFalse(self.telemetry([container]).sample('tavern-api', container)['available'])


class ObservationResponseTests(unittest.IsolatedAsyncioTestCase):
    async def test_fragmented_worker_json_is_reassembled_with_a_hard_size_limit(self):
        class Content:
            def __init__(self, chunks):
                self.chunks = chunks
            async def iter_chunked(self, size):
                for chunk in self.chunks:
                    yield chunk
        response = SimpleNamespace(content=Content([b'{"message":', b'"complete",', b'"count":1}']))
        self.assertEqual(await bounded_json(response), {'message': 'complete', 'count': 1})
        with self.assertRaisesRegex(ValueError, 'size limit'):
            await bounded_json(SimpleNamespace(content=Content([b'x' * (1024 * 1024), b'x'])))


if __name__ == '__main__':
    unittest.main()
