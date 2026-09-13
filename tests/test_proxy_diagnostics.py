import json
import socket
import unittest
from unittest.mock import Mock

from api.proxy_diagnostics import inspect_proxy_trust


def resolver(*addresses):
    return Mock(return_value=[(socket.AF_INET6 if ':' in address else socket.AF_INET,
                              socket.SOCK_STREAM, 6, '', (address, 8080)) for address in addresses])


class ProxyDiagnosticsTests(unittest.TestCase):
    def test_empty_trust_reports_known_gateway_without_other_environment_values(self):
        lookup = resolver('172.24.0.7')
        result = inspect_proxy_trust({'SMTP_PASSWORD': 'private-marker'}, lookup)
        self.assertEqual(result, {'status': 'fail', 'category': 'gateway_trust_missing',
                                 'trustedProxyCidrs': [], 'gateways': [{'address': '172.24.0.7', 'trusted': False}]})
        lookup.assert_called_once_with('tavern-web', 8080, type=socket.SOCK_STREAM)
        self.assertNotIn('private-marker', json.dumps(result))

    def test_explicit_ipv4_and_ipv6_networks_accept_only_matching_gateways(self):
        result = inspect_proxy_trust({'TRUSTED_PROXY_CIDRS': '172.24.0.7/32,fd00:1::/64'}, resolver('172.24.0.7', 'fd00:1::7'))
        self.assertEqual(result['category'], 'resolved_gateways_trusted')
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(len(result['gateways']), 2)
        result = inspect_proxy_trust({'TRUSTED_PROXY_CIDRS': '172.24.0.7/32'}, resolver('172.24.0.8', '172.24.0.7'))
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['gateways'][1], {'address': '172.24.0.8', 'trusted': False})

    def test_invalid_configuration_is_not_echoed_and_does_not_resolve(self):
        lookup = Mock()
        result = inspect_proxy_trust({'TRUSTED_PROXY_CIDRS': 'private-marker'}, lookup)
        self.assertEqual(result, {'status': 'fail', 'category': 'invalid_proxy_cidrs'})
        lookup.assert_not_called()

    def test_missing_or_invalid_dns_returns_bounded_generated_error(self):
        for lookup in (Mock(side_effect=socket.gaierror('private-marker')), resolver(), resolver('private-marker')):
            with self.subTest(lookup=lookup):
                result = inspect_proxy_trust({}, lookup)
                self.assertEqual(result['category'], 'gateway_dns_unavailable')
                self.assertNotIn('private-marker', json.dumps(result))
