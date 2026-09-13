"""Read-only proxy trust inspection, available even when sign-in is blocked.

Run inside tavern-api: python /app/proxy_diagnostics.py
Does not open the account database, read secrets, make HTTP requests or change trust.
"""
import ipaddress
import json
import os
import socket

try:
    from .security import network_list
except ImportError:
    from security import network_list


def inspect_proxy_trust(environ=None, resolver=None):
    environ = os.environ if environ is None else environ
    resolver = socket.getaddrinfo if resolver is None else resolver
    try:
        trusted = network_list(environ.get('TRUSTED_PROXY_CIDRS', ''))
    except ValueError:
        return {'status': 'fail', 'category': 'invalid_proxy_cidrs'}
    # Canonical IP networks only; never echo arbitrary environment text.
    result = {'trustedProxyCidrs': [str(network) for network in trusted]}
    try:
        records = resolver('tavern-web', 8080, type=socket.SOCK_STREAM)
        addresses = sorted({str(ipaddress.ip_address(record[4][0])) for record in records})
    except (OSError, ValueError, IndexError, TypeError):
        return {**result, 'status': 'fail', 'category': 'gateway_dns_unavailable'}
    if not addresses:
        return {**result, 'status': 'fail', 'category': 'gateway_dns_unavailable'}
    gateways = [{'address': address, 'trusted': any(ipaddress.ip_address(address) in network for network in trusted)} for address in addresses]
    accepted = all(gateway['trusted'] for gateway in gateways)
    return {**result, 'status': 'pass' if accepted else 'fail',
            'category': 'resolved_gateways_trusted' if accepted else 'gateway_trust_missing',
            'gateways': gateways}


def main():
    result = inspect_proxy_trust()
    print(json.dumps(result, separators=(',', ':')))
    print('This checks current gateway DNS addresses only. It does not verify the observed request peer, NPM forwarding headers or the full proxy chain.')
    return 0 if result['status'] == 'pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())
