"""Trust boundaries for the dedicated Compose gateway and optional NPM hop."""
import unittest
from unittest.mock import patch

from api.security import ProxyAddressError, client_address, network_list
from api.server import Config


class ProxyTopologyTests(unittest.TestCase):
    def test_https_origin_is_configuration_not_forwarded_scheme(self):
        with patch.dict('os.environ', {'TAVERN_PUBLIC_URL': 'https://chat.example.test'}, clear=True):
            self.assertEqual(Config.environment().public_url, 'https://chat.example.test')
        with patch.dict('os.environ', {'TAVERN_PUBLIC_URL': 'http://chat.example.test'}, clear=True):
            with self.assertRaisesRegex(ValueError, 'HTTPS origin'):
                Config.environment()

    def test_untrusted_npm_stops_before_spoofed_browser_chain(self):
        trusted = network_list('172.30.240.2/32')
        self.assertEqual(client_address('172.30.240.2',
            '127.0.0.1, 203.0.113.9, 172.23.0.3', trusted), '172.23.0.3')

    def test_reserved_npm_exposes_observed_client_but_not_its_claim(self):
        trusted = network_list('172.30.240.2/32,172.23.0.3/32')
        self.assertEqual(client_address('172.30.240.2',
            '127.0.0.1, 203.0.113.9, 172.23.0.3', trusted), '203.0.113.9')
        # The API's dynamic address is irrelevant; a different sender cannot
        # inherit Web's trust even when connected to a shared private network.
        for peer in ('172.24.0.3', '172.24.0.7', '172.30.240.4', '172.23.0.4'):
            with self.subTest(peer=peer), self.assertRaises(ProxyAddressError):
                client_address(peer, '127.0.0.1', trusted)
