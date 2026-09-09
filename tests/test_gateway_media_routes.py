"""Portable configuration checks; ci-gateway.py tests actual built Nginx URIs."""
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


class GatewayMediaRoutesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (ROOT / 'docker/npm/server.conf.template').read_text()
        matches = re.findall(r'location ~ "([^"]+)" \{\s*(if \(\$managed_auth = true\) \{ return 403; \}\s*proxy_pass \$matrix_upstream\$request_uri;)', cls.source)
        cls.patterns = [re.compile(pattern) for pattern, _body in matches]

    def test_every_native_media_upload_alias_has_managed_auth_admission(self):
        for version in ('r0', 'v1', 'v3'):
            for operation in ('upload', 'create', 'upload/chat.example.test/chosen-id'):
                path = '/_matrix/media/' + version + '/' + operation
                with self.subTest(path=path):
                    self.assertTrue(any(pattern.match(path) for pattern in self.patterns))
        for version in ('v1', 'v3', 'unstable'):
            for operation in ('upload', 'create'):
                path = '/_matrix/client/' + version + '/media/' + operation
                with self.subTest(path=path):
                    self.assertTrue(any(pattern.match(path) for pattern in self.patterns))

    def test_upload_admission_does_not_capture_downloads_thumbnails_or_the_quota_gateway(self):
        for path in ('/_matrix/media/v3/download/chat.example.test/id', '/_matrix/media/v1/thumbnail/chat.example.test/id',
                     '/_matrix/client/v1/media/download/chat.example.test/id', '/_matrix/media/v3/config',
                     '/api/matrix/_matrix/media/v3/upload'):
            with self.subTest(path=path):
                self.assertFalse(any(pattern.match(path) for pattern in self.patterns))

    def test_legacy_passthrough_preserves_the_original_encoded_uri(self):
        self.assertIn('location /_matrix/media/ { proxy_pass $matrix_upstream$request_uri; }', self.source)
        # The checked admission blocks only managed mode. Existing legacy-mode
        # clients keep the same native upstream path, with no rewritten media ID.
        self.assertTrue(any(pattern.match('/_matrix/media/v1/upload') for pattern in self.patterns))


if __name__ == '__main__':
    unittest.main()
