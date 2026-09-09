"""Web Push encryption libraries, strict subscriptions and bounded public egress."""
import base64
import hashlib
import json
import re
import time

import aiohttp
import http_ece
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid02
from yarl import URL

try:
    from .link_preview import PublicResolver, preview_url
    from .server import APIError
except ImportError:
    from link_preview import PublicResolver, preview_url
    from server import APIError


def encode64(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode('ascii')


def decode64(value, length):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise APIError(400, 'The browser push subscription has invalid keys.')
    try:
        raw = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
    except ValueError:
        raise APIError(400, 'The browser push subscription has invalid keys.') from None
    if len(raw) != length or encode64(raw) != value:
        raise APIError(400, 'The browser push subscription has invalid keys.')
    return raw


def endpoint_url(value):
    url = preview_url(value)
    if url.scheme != 'https' or url.port != 443 or URL(value).fragment or '\\' in value or any(ord(c) == 127 for c in value):
        raise APIError(400, 'Browser push requires a public HTTPS endpoint on port 443.')
    return url


def subscription_value(value):
    if not isinstance(value, dict) or set(value) - {'endpoint', 'expirationTime', 'keys'}:
        raise APIError(400, 'Send the browser push subscription.')
    endpoint_url(value.get('endpoint'))
    endpoint = value['endpoint']
    keys = value.get('keys')
    if not isinstance(keys, dict) or set(keys) != {'auth', 'p256dh'}:
        raise APIError(400, 'The browser push subscription has invalid keys.')
    public = decode64(keys['p256dh'], 65)
    decode64(keys['auth'], 16)
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public)
    except ValueError:
        raise APIError(400, 'The browser push subscription has an invalid public key.') from None
    expires = value.get('expirationTime')
    if expires is not None and (type(expires) not in (int, float) or not time.time() * 1000 < expires < 253402300800000):
        raise APIError(400, 'This browser push subscription has expired or is invalid.')
    return {'endpoint': endpoint, 'expirationTime': expires, 'keys': dict(keys)}


def subscription_hash(value):
    canonical = json.dumps([value['endpoint'], value['keys']['p256dh'], value['keys']['auth']], separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


async def bounded_json(response, limit=256 * 1024):
    if response.content_length is not None and response.content_length > limit:
        response.close()
        raise APIError(502, 'The notification service response was too large.')
    if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
        response.close()
        raise APIError(502, 'The notification service response encoding was not accepted.')
    body = bytearray()
    async for chunk in response.content.iter_chunked(16384):
        if len(body) + len(chunk) > limit:
            response.close()
            raise APIError(502, 'The notification service response was too large.')
        body.extend(chunk)
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value: raise ValueError('Duplicate JSON key')
            value[key] = item
        return value
    def invalid_constant(_):
        raise ValueError('Invalid JSON number')
    try:
        return json.loads(body, object_pairs_hook=unique, parse_constant=invalid_constant)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise APIError(502, 'The notification service returned an invalid response.') from None


class GuardedResolver(PublicResolver):
    def __init__(self, authorize):
        self.authorize = authorize

    async def resolve(self, *args, **kwargs):
        result = await super().resolve(*args, **kwargs)
        self.authorize()
        return result


async def send_push(subscription, pem, subject, payload, ttl, authorize, reauthorize=None):
    """Never use a vendor sender that follows redirects or buffers whole bodies."""
    endpoint = endpoint_url(subscription['endpoint'])
    raw = json.dumps(payload, separators=(',', ':')).encode()
    if len(raw) > 2048:
        raise APIError(500, 'The notification payload exceeded its bound.')
    encrypted = http_ece.encrypt(raw, dh=decode64(subscription['keys']['p256dh'], 65),
                                 auth_secret=decode64(subscription['keys']['auth'], 16),
                                 private_key=ec.generate_private_key(ec.SECP256R1()), version='aes128gcm')
    vapid = Vapid02.from_pem(pem.encode())
    headers = vapid.sign({'aud': str(endpoint.origin()), 'sub': subject, 'exp': int(time.time()) + 3600})
    headers.update({'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
                    'TTL': str(max(0, min(300, int(ttl)))), 'Urgency': 'normal', 'Accept-Encoding': 'identity'})
    authorize()
    connector = aiohttp.TCPConnector(resolver=GuardedResolver(authorize), use_dns_cache=False, limit=1)
    trace = aiohttp.TraceConfig()
    async def check(*_):
        authorize()
    async def check_headers(*_):
        # aiohttp awaits this hook before serializing/writing headers. Refresh
        # remote policy after DNS/TLS waits, then verify the local lifetime again.
        if reauthorize is not None:
            await reauthorize()
        authorize()
    trace.on_request_start.append(check)
    trace.on_request_headers_sent.append(check_headers)
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=8, connect=4, sock_read=3),
                                     trust_env=False, cookie_jar=aiohttp.DummyCookieJar(), auto_decompress=False,
                                     trace_configs=[trace], max_line_size=8190, max_field_size=8190) as client:
        async with client.post(endpoint, data=encrypted, headers=headers, allow_redirects=False) as response:
            # Provider bodies are unnecessary. Closing avoids unbounded or
            # compressed responses and never logs their endpoint/auth material.
            status = response.status
            retry = response.headers.get('Retry-After', '')
            delay = min(300, int(retry)) if retry.isdecimal() and len(retry) <= 6 else 0
            response.close()
            return status, delay
