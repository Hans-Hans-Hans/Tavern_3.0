"""Durable, signed routing of native Space notices to the optional encrypted bot."""
import asyncio
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import secrets
import time
import uuid
from types import SimpleNamespace
from urllib.parse import quote

from aiohttp import ClientError, ClientTimeout, web

try:
    from .server import APIError, body_json
    from .room_authority import content, policy_model, power, room_authority, room_id, state
    from .server_eligibility import account_status, require_room_eligibility
except ImportError:
    from server import APIError, body_json
    from room_authority import content, policy_model, power, room_authority, room_id, state
    from server_eligibility import account_status, require_room_eligibility

SYSTEM_MESSAGES = 'io.tavern.server.system_messages'
MAX_BODY = 131072
TTL = 1800
BOT_ORIGIN = 'http://integrations:8080'
API_ORIGIN = 'http://tavern-api:8090'
SWEEP_INTERVAL = 3
LOG = logging.getLogger('tavern.system_messages')


def identifier(value, prefix):
    return isinstance(value, str) and bool(re.fullmatch(re.escape(prefix) + r'[^\s\x00-\x1f\x7f]{1,510}', value))


def signature(key, purpose, raw, timestamp):
    return hmac.new(key, '\n'.join(('v1', purpose, timestamp, hashlib.sha256(raw).hexdigest())).encode(), hashlib.sha256).hexdigest()


def headers(key, purpose, raw):
    timestamp = str(int(time.time()))
    return {'Content-Type': 'application/json', 'X-Tavern-System-Timestamp': timestamp,
            'X-Tavern-System-Signature': signature(key, purpose, raw, timestamp)}


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('Duplicate key')
        result[key] = value
    return result


async def signed_body(request, key, purpose):
    if request.content_type != 'application/json': raise APIError(415, 'Expected JSON.')
    raw = bytearray()
    async for chunk in request.content.iter_chunked(8192):
        raw.extend(chunk)
        if len(raw) > MAX_BODY: raise APIError(413, 'The internal request is too large.')
    timestamp = request.headers.get('X-Tavern-System-Timestamp', '')
    supplied = request.headers.get('X-Tavern-System-Signature', '')
    if (len(key) != 32 or not re.fullmatch(r'[0-9]{1,12}', timestamp)
        or abs(time.time() - int(timestamp)) > 30 or not re.fullmatch(r'[0-9a-f]{64}', supplied)
        or not hmac.compare_digest(signature(key, purpose, raw, timestamp), supplied)):
        raise APIError(403, 'This internal request is not authorized.')
    try:
        result = json.loads(raw, object_pairs_hook=unique_json)
        if not isinstance(result, dict): raise ValueError()
        return result
    except (ValueError, UnicodeError): raise APIError(400, 'Invalid internal request.') from None


def valid_envelope(data):
    return (set(data) == {'version', 'eventId', 'serverId', 'configEventId', 'channelId', 'hookId', 'userId', 'change', 'occurredAt', 'audience'}
        and type(data['version']) is int and data['version'] == 1
        and all(identifier(data[key], prefix) for key, prefix in (('eventId', '$'), ('configEventId', '$'), ('serverId', '!'), ('channelId', '!'), ('userId', '@')))
        and isinstance(data['hookId'], str) and bool(re.fullmatch(r'[a-z0-9_-]{1,64}', data['hookId']))
        and data['change'] in ('join', 'leave') and type(data['occurredAt']) is int
        and isinstance(data['audience'], list) and 1 <= len(data['audience']) <= 201
        and all(identifier(user, '@') for user in data['audience'])
        and len(set(data['audience'])) == len(data['audience']))


class SystemMessageManager:
    def __init__(self, service):
        self.service, self.running = service, False
        self.worker = None
        service.store.db.executescript('''
            CREATE TABLE IF NOT EXISTS system_message_deliveries(
                id TEXT PRIMARY KEY,event_id TEXT NOT NULL,config_event_id TEXT NOT NULL,
                server_id TEXT NOT NULL,channel_id TEXT NOT NULL,envelope TEXT,
                status TEXT NOT NULL DEFAULT 'pending',reason TEXT NOT NULL DEFAULT '',
                created REAL NOT NULL,expires REAL NOT NULL,next_attempt REAL NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,sent_event TEXT NOT NULL DEFAULT '',
                UNIQUE(event_id,config_event_id));
            CREATE INDEX IF NOT EXISTS system_message_due ON system_message_deliveries(status,next_attempt);
        ''')

    async def start(self, app):
        async def loop():
            while True:
                await asyncio.sleep(SWEEP_INTERVAL)
                try:
                    await self.sweep()
                except Exception:
                    LOG.warning('System notice delivery is unavailable; durable work will retry.')
        self.worker = asyncio.create_task(loop(), name='tavern-system-messages')

    async def close(self, app):
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)

    def integration(self):
        return getattr(self.service, 'integrations', None)

    def enabled(self):
        return bool(self.integration() and self.integration().enabled)

    def key(self):
        manager = self.integration()
        if not manager: raise APIError(503, 'The encrypted bot is unavailable.')
        path = manager.directory / 'system-messages.hmac'
        try:
            if path.is_symlink() or path.stat().st_size > 128: raise ValueError()
            key = bytes.fromhex(path.read_text().strip())
            if len(key) != 32: raise ValueError()
            return key
        except (OSError, ValueError): raise APIError(503, 'System notices need the configured encrypted bot.') from None

    def bot_identity(self):
        path = self.integration().directory / 'session.json'
        try:
            if path.is_symlink() or path.stat().st_size > 16384: raise ValueError()
            value = json.loads(path.read_bytes())
            if (not isinstance(value, dict) or not identifier(value.get('user_id'), '@')
                or not isinstance(value.get('device_id'), str) or not 1 <= len(value['device_id']) <= 255
                or re.search(r'[\x00-\x1f\x7f]', value['device_id'])): raise ValueError()
            return value['user_id'], value['device_id']
        except (OSError, ValueError, KeyError): raise APIError(503, 'Provision the dedicated encrypted bot before enabling system notices.') from None

    async def configure_bridge(self, reauthorize):
        manager = self.integration()
        async with manager.lock:
            await reauthorize()
            config, _ = manager.read()
            self.bot_identity()
            expected = {'api_url': API_ORIGIN, 'secret_file': '/config/system-messages.hmac'}
            if config.get('system_messages') not in (None, expected): raise APIError(409, 'The system notice bot configuration needs administrator review.')
            path = manager.directory / 'system-messages.hmac'
            if not path.exists():
                with path.open('x', encoding='ascii') as stream:
                    path.chmod(0o600); stream.write(secrets.token_hex(32) + '\n'); stream.flush(); os.fsync(stream.fileno())
            self.key()
            if config.get('system_messages') != expected:
                config['system_messages'] = expected
                manager.write(config)

    def finish(self, identity, status, reason='', event=''):
        self.service.store.db.execute('UPDATE system_message_deliveries SET status=?,reason=?,sent_event=?,envelope=NULL WHERE id=? AND status=\'pending\'', (status, reason, event, identity))

    async def scopes(self, server, channel, parent, child):
        """All reciprocal canonical ancestors restrict; none grants access.

        A bounded graph rejects cycles, dangling links, and oversized ancestry.
        The destination's own role state is checked even when a parent has one.
        """
        observed = {channel: child, server: parent}
        visiting, complete = set(), set()
        async def visit(identity, current, depth):
            if depth > 8 or identity in visiting: return False
            if identity in complete: return True
            visiting.add(identity)
            for (kind, target), event in current.items():
                if kind != 'm.space.parent' or event.content.get('canonical') is not True or not event.content.get('via'): continue
                if target not in observed:
                    if len(observed) >= 16: return False
                    observed[target] = await state(self.service, room_id(target))
                ancestor = observed[target]
                create = content(ancestor, 'm.room.create')
                if (create.get('type') != 'm.space' or create.get('m.federate') is not False
                    or not content(ancestor, 'm.space.child', identity).get('via')
                    or not await visit(target, ancestor, depth + 1)):
                    return False
            visiting.remove(identity); complete.add(identity)
            return True
        return observed if await visit(channel, child, 0) else None

    async def authorize(self, row):
        async with asyncio.timeout(15):
            return await self._authorize(row)

    async def _authorize(self, row):
        if not self.enabled() or row['status'] != 'pending' or row['expires'] <= time.time(): return None
        service = self.service
        data = json.loads(service.store.open(row['envelope']))
        config, config_revision = self.integration().read()
        hook = config['hooks'].get(data['hookId'])
        if not hook or not hook.get('enabled', True) or hook.get('room_id') != data['channelId']: return None
        if config.get('system_messages') != {'api_url': API_ORIGIN, 'secret_file': '/config/system-messages.hmac'}: return None
        bot, device = self.bot_identity()
        if data['userId'] == bot: return None
        parent, child = await state(service, room_id(data['serverId'])), await state(service, room_id(data['channelId']))
        model = policy_model(service)
        checker = model.SystemMessagesPolicy
        current = parent.get((SYSTEM_MESSAGES, ''))
        route = content(parent, SYSTEM_MESSAGES)
        if (not current or current.event_id != data['configEventId'] or not model.valid_system_message_settings(route)
            or not route['enabled'] or route['channelId'] != data['channelId'] or route['hookId'] != data['hookId']
            or not route['joins' if data['change'] == 'join' else 'leaves']
            or not checker.destination(data['serverId'], data['channelId'], parent, child)):
            return None
        recipients = {user for (kind, user), event in child.items() if kind == 'm.room.member' and event.content.get('membership') == 'join'}
        if (bot not in recipients or len(recipients) > 200 or not recipients.issubset(set(data['audience']))
            or not recipients.issubset(set(hook.get('allowed_users', [])))
            or any(content(parent, 'm.room.member', user).get('membership') != 'join' for user in recipients)):
            return None
        scopes = await self.scopes(data['serverId'], data['channelId'], parent, child)
        if scopes is None: return None
        permissions = {'send_messages', 'manage_messages'}
        now = int(time.time() * 1000)
        for scope in scopes.values():
            if content(scope, 'm.room.member', bot).get('membership') != 'join': return None
            policy = content(scope, model.POLICY)
            if (model.POLICY, '') in scope:
                if not model.valid_policy(policy): return None
                if (model.LAYOUT, '') in scope and not model.valid_layout(content(scope, model.LAYOUT)): return None
                permissions.intersection_update(model.permissions(model.ResolvedPolicy(policy, content(scope, model.LAYOUT)), bot, data['channelId']))
            if model.temporary_ban_active(scope, bot, now) or model.timeout_active(scope, bot, now): return None
        if 'send_messages' not in permissions: return None
        powers = content(child, 'm.room.power_levels')
        events = powers.get('events', {})
        threshold = events.get('m.room.encrypted', powers.get('events_default', 0)) if isinstance(events, dict) else None
        if type(threshold) is not int or power(child, bot) < threshold: return None
        channel = content(child, 'io.tavern.channel')
        if channel and not checker.valid_channel(channel) or channel.get('archived'): return None
        redact = powers.get('redact', 50)
        if channel.get('kind') in ('read-only', 'rules', 'announcement') and ('manage_messages' not in permissions or type(redact) is not int or power(child, bot) < redact): return None
        observed_account = account_status(service, bot)
        await require_room_eligibility(service, {'user_id': bot}, data['channelId'], child)
        # Final reads close local/account/config changes hidden behind upstream waits.
        refreshed = {identity: await state(service, identity) for identity in scopes}
        native = await service.matrix('GET', '/_synapse/admin/v2/users/' + quote(bot, safe=''), token=await service.service_token())
        if (not isinstance(native, dict) or native.get('name') != bot
            or not model.ServerEligibilityPolicy.native_available(SimpleNamespace(is_deactivated=native.get('deactivated'),
                is_guest=native.get('is_guest'), locked=native.get('locked'), suspended=native.get('suspended')))):
            return None
        again, _ = self.integration().read()
        snapshot = lambda current: {(kind, key): (getattr(event, 'event_id', None), event.content) for (kind, key), event in current.items()}
        if any(snapshot(current) != snapshot(refreshed[identity]) for identity, current in scopes.items()) or again != config: return None
        fresh = service.store.db.execute('SELECT status,expires FROM system_message_deliveries WHERE id=?', (row['id'],)).fetchone()
        final_account = account_status(service, bot)
        if (not fresh or fresh['status'] != 'pending' or fresh['expires'] <= time.time()
            or not final_account['available'] or final_account != observed_account): return None
        return {'roomId': data['channelId'], 'hookId': data['hookId'], 'audience': sorted(recipients), 'botUserId': bot, 'botDeviceId': device, 'configurationRevision': config_revision}

    async def request_bot(self, path, data):
        raw = json.dumps(data, separators=(',', ':'), ensure_ascii=True).encode()
        async with self.service.http.post(BOT_ORIGIN + path, data=raw, headers=headers(self.key(), 'system-delivery', raw), allow_redirects=False, timeout=ClientTimeout(total=8)) as response:
            body = bytearray()
            async for chunk in response.content.iter_chunked(4096):
                body.extend(chunk)
                if len(body) > 8192: raise APIError(502, 'Invalid encrypted bot response.')
            value = json.loads(body, object_pairs_hook=unique_json)
            if response.status not in (200, 202) or not isinstance(value, dict): raise APIError(503, 'The encrypted bot is unavailable.')
            return value

    async def sweep(self):
        if self.running: return
        self.running = True
        try:
            db, now = self.service.store.db, time.time()
            db.execute("UPDATE system_message_deliveries SET status='cancelled',reason='expired',envelope=NULL WHERE status='pending' AND expires<=?", (now,))
            if not self.enabled():
                db.execute("UPDATE system_message_deliveries SET status='cancelled',reason='disabled',envelope=NULL WHERE status='pending'")
                return
            rows = db.execute("SELECT * FROM system_message_deliveries WHERE status='pending' AND next_attempt<=? ORDER BY next_attempt LIMIT 5", (now,)).fetchall()
            for row in rows:
                try:
                    authorization = await self.authorize(row)
                    if authorization is None:
                        self.finish(row['id'], 'cancelled', 'route_or_audience_changed'); continue
                    data = json.loads(self.service.store.open(row['envelope']))
                    result = await self.request_bot('/internal/system-deliveries', {'id': row['id'], 'expiresAt': int(row['expires'] * 1000),
                        'source': data, 'authorization': authorization})
                    if result.get('status') == 'sent' and identifier(result.get('eventId'), '$'):
                        self.finish(row['id'], 'sent', event=result['eventId'])
                    elif result.get('status') == 'cancelled':
                        self.finish(row['id'], 'cancelled', 'bot_cancelled')
                    elif result.get('status') not in ('pending', 'blocked'): raise ValueError('Unconfirmed bot queue')
                    db.execute("UPDATE system_message_deliveries SET next_attempt=?,attempts=attempts+1,reason=? WHERE id=? AND status='pending'", (time.time() + 5, 'bot_pending', row['id']))
                except Exception:
                    db.execute("UPDATE system_message_deliveries SET next_attempt=?,attempts=attempts+1,reason='delivery_unavailable' WHERE id=? AND status='pending'", (time.time() + min(300, 2 ** min(row['attempts'] + 1, 8)), row['id']))
        finally:
            self.running = False


async def manage(request):
    progress = {'stage': 'session'}
    try:
        return await _manage(request, progress)
    except (APIError, ClientError, asyncio.TimeoutError, ValueError, web.HTTPException):
        raise
    except Exception as error:
        # These are code-owned stage/type names only. Never log exception text,
        # native responses, request bodies, Matrix tokens or bot configuration.
        LOG.error('System notice settings failed at %s (%s).', progress['stage'], type(error).__name__)
        raise APIError(500, 'System notice settings could not be loaded or saved. Reload or ask an administrator to check the system notice service logs.', 'SYSTEM_NOTICES_UNAVAILABLE') from None


async def _manage(request, progress):
    service = request.app['service']; manager = service.system_messages
    session = service.require_session(request)
    if request.method == 'PUT': service.store.rate('system-notices-write:' + session['user_id'], 30, 60)
    server = room_id(request.match_info['server'])
    async def reauthorize():
        service.require_session(request)
        authority = await room_authority(service, session, server)
        model = authority.model
        current = authority.state.get((SYSTEM_MESSAGES, ''))
        probe = SimpleNamespace(sender=session['user_id'], state_key='', content={'version': 1, 'enabled': False, 'channelId': '', 'hookId': '',
            'joins': True, 'leaves': False, 'io.tavern.previous_event': current.event_id if current else None})
        if not model.SystemMessagesPolicy({}, None, model).may_configure(probe, authority.state): raise APIError(403, 'Your current server permissions do not allow system notice settings.')
        service.require_session(request)
        return authority
    progress['stage'] = 'initial_authority'
    authority = await reauthorize()
    progress['stage'] = 'request_validation'
    data = await body_json(request) if request.method == 'PUT' else None
    model = authority.model
    if data is not None:
        async with service.user_locks.setdefault(session['user_id'], asyncio.Lock()):
            service.require_session(request)
            if set(data) != {'settings', 'confirmation'} or data['confirmation'] != server or not model.valid_system_message_settings(data['settings']): raise APIError(400, 'Choose valid settings and confirm the server ID.')
            settings = data['settings']
            if settings['enabled']:
                if not manager.enabled(): raise APIError(503, 'Enable and provision the encrypted bot before enabling system notices.')
                progress['stage'] = 'write_configuration'
                config, _ = manager.integration().read()
                hook = config['hooks'].get(settings['hookId'])
                if not hook or not hook.get('enabled', True) or hook.get('room_id') != settings['channelId']: raise APIError(400, 'Choose an enabled encrypted hook for this destination.')
                progress['stage'] = 'write_destination'
                child = await state(service, room_id(settings['channelId']))
                if not model.SystemMessagesPolicy.destination(server, settings['channelId'], authority.state, child) or content(child, 'm.room.member', session['user_id']).get('membership') != 'join': raise APIError(403, 'Join the selected encrypted child channel.')
                progress['stage'] = 'configure_bridge'
                await manager.configure_bridge(reauthorize)
            progress['stage'] = 'write_authority'
            authority = await reauthorize()
            service.require_session(request)
            progress['stage'] = 'native_write'
            result = await service.matrix('PUT', '/_matrix/client/v3/rooms/' + quote(server, safe='') + '/state/' + SYSTEM_MESSAGES, settings, token=service.store.open(session['token']))
            if not identifier(result.get('event_id'), '$'): raise APIError(502, 'The homeserver did not confirm this setting. Reload before retrying.')
            service.require_session(request)
            progress['stage'] = 'write_audit'
            service.audit(session['user_id'], 'server_system_messages_changed', server)
            return web.json_response({'eventId': result['event_id']})
    config, revision, ready = {'hooks': {}}, '', False
    if manager.enabled():
        try:
            progress['stage'] = 'read_configuration'
            config, revision = manager.integration().read()
            progress['stage'] = 'read_bot_identity'
            manager.bot_identity()
            ready = True
        except APIError as error:
            if error.status != 503: raise
    options = []
    progress['stage'] = 'read_destinations'
    for hook_id, hook in list(config['hooks'].items())[:100]:
        destination = hook.get('room_id', '')
        if not hook.get('enabled', True) or not content(authority.state, 'm.space.child', destination).get('via'): continue
        child = await state(service, room_id(destination))
        if content(child, 'm.room.member', session['user_id']).get('membership') == 'join' and model.SystemMessagesPolicy.destination(server, destination, authority.state, child):
            options.append({'hookId': hook_id, 'roomId': destination, 'name': hook.get('name', hook_id)})
    progress['stage'] = 'final_authority'
    authority = await reauthorize()
    progress['stage'] = 'delivery_counts'
    counts = {row['status']: row['total'] for row in service.store.db.execute('SELECT status,count(*) AS total FROM system_message_deliveries WHERE server_id=? GROUP BY status', (server,))}
    current = authority.state.get((SYSTEM_MESSAGES, ''))
    progress['stage'] = 'response'
    return web.json_response({'enabled': manager.enabled(), 'ready': ready, 'settings': dict(current.content) if current else None, 'eventId': current.event_id if current else None,
        'destinations': options, 'counts': counts, 'configurationRevision': revision}, headers={'Cache-Control': 'no-store'})


async def ingest(request):
    service = request.app['service']; manager = service.system_messages
    try:
        key = bytes.fromhex(Path(os.environ.get('PRIVACY_KEY_FILE', '/synapse/tavern-privacy.key')).read_text().strip())
    except (OSError, ValueError): raise APIError(403, 'This internal request is not authorized.') from None
    data = await signed_body(request, key, 'system-events')
    if not valid_envelope(data): raise APIError(400, 'Invalid native system event.')
    now = time.time()
    if not manager.enabled() or not now * 1000 - TTL * 1000 <= data['occurredAt'] <= now * 1000 + 30000:
        return web.json_response({'accepted': True}, headers={'Cache-Control': 'no-store'})
    identity = str(uuid.uuid5(uuid.NAMESPACE_URL, 'tavern-system\n' + data['eventId'] + '\n' + data['configEventId']))
    db = service.store.db
    previous = db.execute('SELECT id FROM system_message_deliveries WHERE id=?', (identity,)).fetchone()
    if not previous:
        if db.execute("SELECT count(*) FROM system_message_deliveries WHERE status='pending'").fetchone()[0] >= 2000: raise APIError(503, 'System notice queue is full.')
        expires = min(now + TTL, data['occurredAt'] / 1000 + TTL)
        db.execute('INSERT INTO system_message_deliveries(id,event_id,config_event_id,server_id,channel_id,envelope,created,expires,next_attempt) VALUES(?,?,?,?,?,?,?,?,?)',
            (identity, data['eventId'], data['configEventId'], data['serverId'], data['channelId'], service.store.seal(json.dumps(data)), now, expires, now))
    return web.json_response({'accepted': True}, status=200 if previous else 202, headers={'Cache-Control': 'no-store'})


async def authorize_delivery(request):
    manager = request.app['service'].system_messages
    data = await signed_body(request, manager.key(), 'system-authorize')
    if set(data) != {'id'} or not isinstance(data['id'], str) or len(data['id']) != 36: raise APIError(400, 'Invalid system delivery.')
    row = manager.service.store.db.execute('SELECT * FROM system_message_deliveries WHERE id=?', (data['id'],)).fetchone()
    permission = await manager.authorize(row) if row else None
    return web.json_response({'allow': permission is not None, 'authorization': permission}, headers={'Cache-Control': 'no-store'})


def register_routes(app):
    manager = app['service'].system_messages = SystemMessageManager(app['service'])
    app.on_startup.append(manager.start)
    app.on_cleanup.insert(0, manager.close)
    app.add_routes([web.get('/api/servers/{server}/system-messages', manage), web.put('/api/servers/{server}/system-messages', manage),
        web.post('/api/internal/system-events', ingest), web.post('/api/internal/system-deliveries/authorize', authorize_delivery)])
