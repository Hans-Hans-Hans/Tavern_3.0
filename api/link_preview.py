"""Explicit, authenticated text-only link previews with DNS-pinned public egress.

No credentials, cookies, referrer, remote images, scripts or page markup cross
the boundary. aiohttp's custom resolver fixes connection addresses to the
validated DNS response; every redirect undergoes the same checks.
"""
import asyncio
from html.parser import HTMLParser
import ipaddress
import socket
from aiohttp import ClientSession, ClientTimeout, DummyCookieJar, TCPConnector, web
from aiohttp.abc import AbstractResolver
from yarl import URL

try:
    from .server import APIError, body_json
except ImportError:
    from server import APIError, body_json

MAX_BYTES = 128 * 1024


def public_address(value):
    address = ipaddress.ip_address(value)
    if getattr(address, 'scope_id', None):
        return False
    if address.version == 6 and any(address in network for network in (ipaddress.ip_network('64:ff9b::/96'), ipaddress.ip_network('64:ff9b:1::/48'))):
        return False
    return address.is_global and not address.is_multicast and not address.is_reserved and not getattr(address, 'ipv4_mapped', None) and not getattr(address, 'sixtofour', None) and not getattr(address, 'teredo', None)


def preview_url(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(char) < 32 for char in value):
        raise APIError(400, 'Choose a valid public web link.')
    try:
        url = URL(value)
        if url.scheme not in {'http', 'https'} or not url.host or url.user is not None or url.password is not None or url.port not in {80, 443}:
            raise ValueError()
        if url.host.casefold().rstrip('.').endswith(('.localhost', '.local', '.internal', '.test', '.invalid')) or url.host.casefold().rstrip('.') == 'localhost':
            raise ValueError()
        try:
            ipaddress.ip_address(url.host)
        except ValueError:
            # aiohttp bypasses custom resolvers for numeric-looking hosts.
            # Reject socket's legacy integer/octal/short IPv4 spellings here,
            # independent of connector version-specific protections.
            if ':' in url.host or url.host.replace('.', '').isdigit():
                raise ValueError()
        else:
            if not public_address(url.host):
                raise ValueError()
        return url.with_fragment(None)
    except ValueError:
        raise APIError(400, 'Previews are available only for public HTTP or HTTPS pages on standard web ports.') from None


class PublicResolver(AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_UNSPEC):
        answers = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM, family=family)
        if not answers or len(answers) > 64 or any(not public_address(answer[4][0]) for answer in answers):
            raise APIError(400, 'This address cannot be used for a public preview.')
        return [{'hostname': host, 'host': answer[4][0], 'port': port, 'family': answer[0], 'proto': answer[2], 'flags': socket.AI_NUMERICHOST} for answer in answers]

    async def close(self):
        pass


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_title, self.title, self.meta = False, '', {}

    def handle_starttag(self, tag, attributes):
        if tag == 'title':
            self.in_title = True
        if tag == 'meta':
            attrs = dict(attributes)
            key = (attrs.get('property') or attrs.get('name') or '').lower()
            if key in {'og:title', 'og:description', 'description', 'og:site_name'} and key not in self.meta:
                self.meta[key] = ' '.join((attrs.get('content') or '').split())[:600]

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title = (self.title + data)[:300]

    def result(self, url):
        return {'url': str(url), 'title': (self.meta.get('og:title') or ' '.join(self.title.split()) or url.host)[:200], 'description': (self.meta.get('og:description') or self.meta.get('description') or '')[:500], 'siteName': self.meta.get('og:site_name', '')[:100]}


async def fetch_preview(value):
    url = preview_url(value)
    connector = TCPConnector(resolver=PublicResolver(), use_dns_cache=False, limit=2)
    async with ClientSession(connector=connector, timeout=ClientTimeout(total=6, connect=3, sock_read=3), cookie_jar=DummyCookieJar(), trust_env=False, auto_decompress=False, headers={'User-Agent': 'Tavern-Link-Preview/1.0', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity'}) as client:
        for attempt in range(4):
            async with client.get(url, allow_redirects=False) as response:
                if response.status in {301, 302, 303, 307, 308}:
                    target = response.headers.get('Location')
                    if not target:
                        raise APIError(400, 'The page returned an invalid redirect.')
                    url = preview_url(str(url.join(URL(target))))
                    continue
                if response.status != 200 or response.content_type not in {'text/html', 'application/xhtml+xml'} or response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
                    raise APIError(400, 'This page does not offer a text preview.')
                content = bytearray()
                async for chunk in response.content.iter_chunked(16384):
                    content.extend(chunk[:MAX_BYTES - len(content)])
                    if len(content) >= MAX_BYTES:
                        break
                parser = Metadata()
                try:
                    parser.feed(content.decode(response.charset or 'utf-8', errors='replace'))
                except LookupError:
                    parser.feed(content.decode('utf-8', errors='replace'))
                return parser.result(url)
        raise APIError(400, 'This page redirects too many times.')


async def preview(request):
    service = request.app['service']
    session = service.require_session(request)
    service.store.rate('link-preview:' + session['user_id'], 20, 60)
    service.store.rate('link-preview-global', 120, 60)
    value = await body_json(request)
    if value.get('consent') is not True:
        raise APIError(400, 'Choose Load preview to contact this website.')
    async with asyncio.timeout(8):
        async with request.app['preview_slots']:
            return web.json_response(await fetch_preview(value.get('url')))


def register_routes(app):
    app['preview_slots'] = asyncio.Semaphore(4)
    app.add_routes([web.post('/api/link-preview', preview)])
