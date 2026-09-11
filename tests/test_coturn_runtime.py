"""Run the actual Compose entrypoint with only hostname/binary boundaries stubbed."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
SHELL = shutil.which('sh') or (r'C:\Program Files\Git\usr\bin\sh.exe' if os.name == 'nt' else None)


@unittest.skipUnless(SHELL and Path(SHELL).exists(), 'POSIX shell required')
class CoturnRuntimeTests(unittest.TestCase):
    def setUp(self):
        service = yaml.safe_load((ROOT / 'compose.yaml').read_text())['services']['coturn']
        self.assertEqual(service['entrypoint'], ['/bin/sh', '-ec'])
        self.assertEqual(service['command'][1:], ['tavern-coturn', '-c', '/config/turnserver.conf'])
        self.assertEqual(service['cap_add'], ['NET_BIND_SERVICE'])
        self.assertEqual(service['networks'], ['media'])
        self.assertTrue(service['read_only'])
        self.script = service['command'][0].replace('$$', '$')

    def run_entrypoint(self, address, hostname_status='0', extra_args=()):
        with tempfile.TemporaryDirectory() as directory:
            capture = Path(directory) / 'capture.sh'
            capture.write_text("printf '%s\\n' \"$@\"\n", encoding='utf-8')
            # Keep all production validation/argument handling. Substitute only
            # the executable boundary, which otherwise requires a real coturn.
            script = self.script.replace('exec /usr/bin/turnserver ', 'exec "$TAVERN_TEST_SHELL" "$TAVERN_TEST_CAPTURE" ')
            script = 'hostname() { printf \'%s\\n\' "$TAVERN_TEST_ADDRESS"; return "$TAVERN_TEST_HOSTNAME_STATUS"; }\n' + script
            env = {**os.environ, 'TAVERN_TEST_ADDRESS': address, 'TAVERN_TEST_HOSTNAME_STATUS': hostname_status,
                   'TAVERN_TEST_SHELL': str(SHELL), 'TAVERN_TEST_CAPTURE': capture.as_posix()}
            return subprocess.run([str(SHELL), '-ec', script, 'tavern-coturn', '-c', '/config/turnserver.conf', *extra_args],
                                  env=env, capture_output=True, text=True, timeout=5)

    def test_exact_own_address_is_added_and_config_arguments_are_unchanged(self):
        for address in ['172.23.0.3', '10.42.0.2', '192.168.250.2', '  172.23.0.3 \n']:
            with self.subTest(address=address):
                value = self.run_entrypoint(address, extra_args=('--realm=literal room',))
                self.assertEqual(value.returncode, 0, value.stderr)
                self.assertEqual(value.stdout.splitlines(), ['-c', '/config/turnserver.conf', '--realm=literal room', '--relay-ip=' + address.strip(), '--allowed-peer-ip=' + address.strip()])

    def test_ambiguous_unsafe_noncanonical_and_nonunicast_addresses_never_execute(self):
        for address in ['', '172.23.0.3 172.23.0.4', '172.23.0.3\n172.23.0.4', '::1', '127.0.0.1', '0.0.0.0',
                        '224.0.0.1', '255.255.255.255', '169.254.0.2', '172.23.0.256', '172.023.0.3', '172.23.0.3.',
                        '.172.23.0.3', '172..0.3', '*.0.0.1', '$(printf attacker)', '--allowed-peer-ip=0.0.0.0-255.255.255.255']:
            with self.subTest(address=address):
                value = self.run_entrypoint(address)
                self.assertNotEqual(value.returncode, 0)
                self.assertEqual(value.stdout, '')
                self.assertEqual(value.stderr.strip(), 'TURN requires one canonical container IPv4 address.')

    def test_failed_hostname_lookup_must_not_start_even_if_it_prints_an_address(self):
        value = self.run_entrypoint('172.23.0.3', hostname_status='1')
        self.assertNotEqual(value.returncode, 0)
        self.assertEqual(value.stdout, '')


if __name__ == '__main__':
    unittest.main()
