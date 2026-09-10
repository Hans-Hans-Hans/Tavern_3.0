"""Read-only, secret-safe operator checks for the deployed call services.

Run inside tavern-api: python /app/call_diagnostics.py [--public]
No Service/Store is constructed and no Matrix account or SFU room is created.
"""
import argparse
import asyncio
import json
import logging
import os
import secrets
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit

import aiohttp

try:
    from .server import Config, APIError
    from .call_moderation import CallModerator, SUPPORTED_AUTH_IMAGE, admin_token
except ImportError:
    from server import Config, APIError
    from call_moderation import CallModerator, SUPPORTED_AUTH_IMAGE, admin_token

INVALID_TOKEN = 'tavern-diagnostic-deliberately-invalid-openid-token'
MAX_BODY = 8192
REQUEST_TIMEOUT = 4
TOTAL_TIMEOUT = 12
STAGES = frozenset(('configuration', 'synapse_openid', 'issuer_health', 'sfu_health',
                    'sfu_credentials', 'public_server_discovery', 'public_client_discovery', 'public_openid'))
CATEGORIES = frozenset(('calls_disabled', 'unsupported_issuer', 'invalid_configuration', 'credentials_unavailable',
                        'invalid_token_rejected', 'reachable', 'credentials_accepted', 'unexpected_room',
                        'unauthorized', 'not_found', 'upstream_error', 'unexpected_status',
                        'invalid_response', 'response_too_large', 'unsupported_encoding',
                        'redirect_blocked', 'timeout', 'tls_error', 'connection_error',
                        'discovery_matches', 'discovery_mismatch', 'diagnostic_error'))


def result(stage, category, *, passed=False, status=None):
    # Only these generated values can reach terminal output, including failures.
    if stage not in STAGES or category not in CATEGORIES or status is not None and (type(status) is not int or not 100 <= status <= 599):
        raise ValueError('Invalid diagnostic result')
    return {'stage': stage, 'status': 'pass' if passed else 'fail', 'category': category,
            **({'http_status': status} if status is not None else {})}


def unique_object(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ValueError('Repeated key')
        value[key] = item
    return value


def status_category(status):
    if 300 <= status < 400:
        return 'redirect_blocked'
    if status in (401, 403):
        return 'unauthorized'
    if status == 404:
        return 'not_found'
    if status >= 500:
        return 'upstream_error'
    return 'unexpected_status'


async def probe(http, stage, url, *, method='GET', params=None, body=None, headers=None, expected=None):
    """Never return/log response text, request URLs, headers or exceptions."""
    status = None
    try:
        async with http.request(method, url, params=params, json=body, headers=headers,
                                allow_redirects=False, auto_decompress=False,
                                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)) as response:
            status = response.status
            if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
                return result(stage, 'unsupported_encoding', status=status)
            raw = bytearray()
            async for chunk in response.content.iter_chunked(1024):
                raw.extend(chunk)
                if len(raw) > MAX_BODY:
                    return result(stage, 'response_too_large', status=status)
            if 300 <= status < 400:
                return result(stage, 'redirect_blocked', status=status)
            if ((stage in ('synapse_openid', 'public_openid') and status != 401)
                    or stage == 'sfu_credentials' and status not in (200, 404)
                    or stage in ('public_server_discovery', 'public_client_discovery') and status != 200):
                return result(stage, status_category(status), status=status)
            data = None
            if stage not in ('issuer_health', 'sfu_health'):
                try:
                    data = json.loads(raw, object_pairs_hook=unique_object)
                except (ValueError, UnicodeError):
                    return result(stage, 'not_found' if status == 404 else 'invalid_response', status=status)
                if not isinstance(data, dict):
                    return result(stage, 'invalid_response', status=status)
            if stage in ('synapse_openid', 'public_openid'):
                if status == 401 and data.get('errcode') == 'M_UNKNOWN_TOKEN':
                    return result(stage, 'invalid_token_rejected', passed=True, status=status)
            elif stage in ('issuer_health', 'sfu_health'):
                if status == 200:
                    return result(stage, 'reachable', passed=True, status=status)
            elif stage == 'sfu_credentials':
                # Pinned local/Redis stores return an empty 200; PSRPC can return
                # 404 not_found. Both occur after room-scoped admin validation.
                if status == 404 and data.get('code') == 'not_found':
                    return result(stage, 'credentials_accepted', passed=True, status=status)
                if status == 200 and set(data) <= {'participants'}:
                    if data.get('participants', []) == []:
                        return result(stage, 'credentials_accepted', passed=True, status=status)
                    return result(stage, 'unexpected_room', status=status)
            elif stage == 'public_server_discovery' and status == 200:
                valid = data.get('m.server') == expected
                return result(stage, 'discovery_matches' if valid else 'discovery_mismatch', passed=valid, status=status)
            elif stage == 'public_client_discovery' and status == 200:
                homeserver = data.get('m.homeserver')
                valid = isinstance(homeserver, dict) and homeserver.get('base_url') in (expected, expected + '/')
                return result(stage, 'discovery_matches' if valid else 'discovery_mismatch', passed=valid, status=status)
            return result(stage, status_category(status), status=status)
    except asyncio.TimeoutError:
        return result(stage, 'timeout', status=status)
    except (aiohttp.ClientSSLError, aiohttp.ServerFingerprintMismatch):
        return result(stage, 'tls_error', status=status)
    except (aiohttp.ClientError, OSError):
        return result(stage, 'connection_error', status=status)
    except Exception:
        return result(stage, 'diagnostic_error', status=status)


def credentials(config):
    moderator = CallModerator(SimpleNamespace(config=config))
    # These two known deployment files are the only private files read. Bound
    # accidental oversized inputs before reusing the production validator.
    for name in ('livekit_key', 'livekit_secret'):
        if (moderator.directory / name).stat().st_size > 1024:
            raise ValueError('Oversized credential')
    return moderator.credentials()


async def diagnose(config, http, *, public=False):
    if os.environ.get('CALLS_ENABLED') != 'true':
        return [result('configuration', 'calls_disabled')]
    if os.environ.get('RTC_AUTH_IMAGE', SUPPORTED_AUTH_IMAGE) != SUPPORTED_AUTH_IMAGE:
        return [result('configuration', 'unsupported_issuer')]
    parsed = urlsplit(config.public_url)
    internal = urlsplit(config.synapse_url)
    # Config.environment validates the public URL too; repeat here to keep this
    # callable helper safe. Never follow a .well-known-selected destination.
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/')
            or internal.scheme not in ('http', 'https') or not internal.hostname or internal.username or internal.password or internal.query or internal.fragment or internal.path not in ('', '/')):
        return [result('configuration', 'invalid_configuration')]
    try:
        public_port, internal_port = parsed.port, internal.port
        if public_port == 0 or internal_port == 0:
            raise ValueError('Invalid port')
    except ValueError:
        return [result('configuration', 'invalid_configuration')]
    tasks = [probe(http, 'synapse_openid', config.synapse_url.rstrip('/') + '/_matrix/federation/v1/openid/userinfo', params={'access_token': INVALID_TOKEN}),
             probe(http, 'issuer_health', 'http://rtc-auth:8080/healthz'),
             probe(http, 'sfu_health', 'http://livekit:7880/')]
    credential_failure = None
    try:
        key, secret = credentials(config)
        room = 'tavern-diagnostic-' + secrets.token_hex(16)
        token = admin_token(key, secret, room)
        tasks.append(probe(http, 'sfu_credentials', 'http://livekit:7880/twirp/livekit.RoomService/ListParticipants',
                           method='POST', body={'room': room}, headers={'Authorization': 'Bearer ' + token}))
    except (APIError, OSError, ValueError, UnicodeError):
        credential_failure = result('sfu_credentials', 'credentials_unavailable')
    if public:
        origin = config.public_url.rstrip('/')
        authority = parsed.netloc if public_port else parsed.netloc + ':443'
        tasks.extend((probe(http, 'public_server_discovery', origin + '/.well-known/matrix/server', expected=authority),
                      probe(http, 'public_client_discovery', origin + '/.well-known/matrix/client', expected=origin),
                      probe(http, 'public_openid', origin + '/_matrix/federation/v1/openid/userinfo', params={'access_token': INVALID_TOKEN})))
    values = await asyncio.gather(*tasks)
    if credential_failure:
        values.insert(3, credential_failure)
    return values


async def run(public=False):
    try:
        config = Config.environment()
        async with asyncio.timeout(TOTAL_TIMEOUT):
            # Normal certificate verification; no environment proxy, cookies,
            # ambient credentials, redirects, sync or SDK session initialization.
            async with aiohttp.ClientSession(trust_env=False, cookie_jar=aiohttp.DummyCookieJar()) as http:
                return await diagnose(config, http, public=public)
    except asyncio.TimeoutError:
        return [result('configuration', 'timeout')]
    except Exception:
        return [result('configuration', 'invalid_configuration')]


def main(argv=None):
    parser = argparse.ArgumentParser(description='Read-only call-service checks with sanitized output.')
    parser.add_argument('--public', action='store_true', help='Also check the configured public HTTPS origin without following discovery or redirects.')
    args = parser.parse_args(argv)
    logging.disable(logging.CRITICAL)
    try:
        values = asyncio.run(run(args.public))
    except KeyboardInterrupt:
        values = [result('configuration', 'diagnostic_error')]
    for value in values:
        print(json.dumps(value, separators=(',', ':')))
    return 0 if all(value['status'] == 'pass' for value in values) else 1


if __name__ == '__main__':
    sys.exit(main())
