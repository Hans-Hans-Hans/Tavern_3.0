"""Private signed system-notice queue using the existing pinned bot identity."""
import asyncio
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import time
import uuid

from aiohttp import ClientSession, ClientTimeout, web

API_ORIGIN = 'http://tavern-api:8090'
MAX_BODY = 131072


def signature(key, purpose, raw, stamp):
    return hmac.new(key, '\n'.join(('v1', purpose, stamp, hashlib.sha256(raw).hexdigest())).encode(), hashlib.sha256).hexdigest()


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def configured_key(config, directory):
    settings = config.get('system_messages')
    if settings is None: return None
    if settings != {'api_url': API_ORIGIN, 'secret_file': '/config/system-messages.hmac'}:
        raise ValueError('Invalid system notice configuration')
    path = Path(directory) / 'system-messages.hmac'
    if path.is_symlink() or path.stat().st_size > 128: raise ValueError('Invalid private signing key')
    key = bytes.fromhex(path.read_text().strip())
    if len(key) != 32: raise ValueError('Invalid private signing key')
    return key


def identifier(value, prefix):
    return isinstance(value, str) and bool(re.fullmatch(re.escape(prefix) + r'[^\s\x00-\x1f\x7f]{1,510}', value))


def valid_delivery(data):
    if not isinstance(data, dict) or set(data) != {'id', 'expiresAt', 'source', 'authorization'}: return False
    try:
        if str(uuid.UUID(data['id'])) != data['id']: return False
    except (ValueError, TypeError, AttributeError): return False
    source, authorization = data['source'], data['authorization']
    return (type(data['expiresAt']) is int and isinstance(source, dict) and isinstance(authorization, dict)
        and set(source) == {'version', 'eventId', 'serverId', 'configEventId', 'channelId', 'hookId', 'userId', 'change', 'occurredAt', 'audience'}
        and type(source['version']) is int and source['version'] == 1
        and all(identifier(source[key], prefix) for key, prefix in (('eventId', '$'), ('configEventId', '$'), ('serverId', '!'), ('channelId', '!'), ('userId', '@')))
        and source['change'] in ('join', 'leave') and isinstance(source['hookId'], str) and bool(re.fullmatch(r'[a-z0-9_-]{1,64}', source['hookId']))
        and type(source['occurredAt']) is int and isinstance(source['audience'], list) and 1 <= len(source['audience']) <= 201
        and all(identifier(user, '@') for user in source['audience']) and len(set(source['audience'])) == len(source['audience'])
        and valid_authorization(authorization, source))


def valid_authorization(data, source):
    return (isinstance(data, dict) and set(data) == {'roomId', 'hookId', 'audience', 'botUserId', 'botDeviceId', 'configurationRevision'}
        and data['roomId'] == source['channelId'] and data['hookId'] == source['hookId']
        and identifier(data['botUserId'], '@') and isinstance(data['botDeviceId'], str) and 1 <= len(data['botDeviceId']) <= 255
        and isinstance(data['configurationRevision'], str) and bool(re.fullmatch(r'[0-9a-f]{64}', data['configurationRevision']))
        and isinstance(data['audience'], list) and 1 <= len(data['audience']) <= 200
        and all(identifier(user, '@') for user in data['audience']) and len(set(data['audience'])) == len(data['audience'])
        and set(data['audience']).issubset(source['audience']) and data['botUserId'] in data['audience'])


def notice_content(source):
    return {'msgtype': 'm.notice', 'body': source['userId'] + (' joined the server.' if source['change'] == 'join' else ' left the server.'),
        'io.tavern.system': {'kind': 'member_' + source['change'], 'server_id': source['serverId'], 'source_event_id': source['eventId']}}


class SystemDeliveries:
    def __init__(self, bridge, directory):
        self.bridge, self.directory = bridge, Path(directory)
        self.http = None
        bridge.db.execute('''CREATE TABLE IF NOT EXISTS system_deliveries(id TEXT PRIMARY KEY,payload BLOB,nonce BLOB,tag BLOB,
            status TEXT NOT NULL,expires INTEGER NOT NULL,next_attempt INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,event_id TEXT NOT NULL DEFAULT '')''')
        bridge.db.commit()

    def finish(self, identity, status, event=''):
        with self.bridge.db:
            self.bridge.db.execute("UPDATE system_deliveries SET status=?,event_id=?,payload=NULL,nonce=NULL,tag=NULL WHERE id=? AND status='pending'", (status, event, identity))

    async def enqueue(self, request):
        from Crypto.Cipher import AES
        if request.content_type != 'application/json': raise web.HTTPUnsupportedMediaType()
        raw = await request.read()
        if len(raw) > MAX_BODY: raise web.HTTPRequestEntityTooLarge(max_size=MAX_BODY, actual_size=len(raw))
        async with self.bridge.matrix_lock:
            self.bridge.reload_configuration()
            key = configured_key(self.bridge.config, self.directory)
            if key is None: raise web.HTTPNotFound()
            stamp, supplied = request.headers.get('X-Tavern-System-Timestamp', ''), request.headers.get('X-Tavern-System-Signature', '')
            if (not re.fullmatch(r'[0-9]{1,12}', stamp) or abs(time.time() - int(stamp)) > 30 or not re.fullmatch(r'[0-9a-f]{64}', supplied)
                or not hmac.compare_digest(signature(key, 'system-delivery', raw, stamp), supplied)):
                raise web.HTTPForbidden()
            try:
                data = json.loads(raw, object_pairs_hook=unique_json)
                if not valid_delivery(data): raise ValueError()
            except (ValueError, UnicodeError): raise web.HTTPBadRequest(text='Invalid system notice') from None
            previous = self.bridge.db.execute('SELECT status,event_id FROM system_deliveries WHERE id=?', (data['id'],)).fetchone()
            if previous: return web.json_response({'status': previous[0], 'eventId': previous[1]})
            now = int(time.time() * 1000)
            if not now < data['expiresAt'] <= now + 1800000: raise web.HTTPBadRequest(text='Expired system notice')
            if self.bridge.db.execute("SELECT COUNT(*) FROM system_deliveries WHERE status='pending'").fetchone()[0] >= 2000: raise web.HTTPServiceUnavailable(text='System notice queue is full')
            cipher = AES.new(self.bridge.queue_key, AES.MODE_GCM, nonce=secrets.token_bytes(12)); cipher.update(('system\n' + data['id']).encode())
            payload, tag = cipher.encrypt_and_digest(raw)
            with self.bridge.db:
                self.bridge.db.execute('INSERT INTO system_deliveries(id,payload,nonce,tag,status,expires,next_attempt) VALUES(?,?,?,?,?,?,?)',
                    (data['id'], payload, cipher.nonce, tag, 'pending', data['expiresAt'], now))
            return web.json_response({'status': 'pending', 'eventId': ''}, status=202)

    async def authorize(self, identity):
        key = configured_key(self.bridge.config, self.directory)
        if key is None: return None
        raw, stamp = json.dumps({'id': identity}, separators=(',', ':')).encode(), str(int(time.time()))
        if self.http is None: self.http = ClientSession(timeout=ClientTimeout(total=8), trust_env=False)
        async with self.http.post(API_ORIGIN + '/api/internal/system-deliveries/authorize', data=raw, headers={
            'Content-Type': 'application/json', 'X-Tavern-System-Timestamp': stamp,
            'X-Tavern-System-Signature': signature(key, 'system-authorize', raw, stamp)}, allow_redirects=False) as response:
            body = bytearray()
            async for chunk in response.content.iter_chunked(8192):
                body.extend(chunk)
                if len(body) > MAX_BODY: raise RuntimeError('Unbounded system authorization response')
            result = json.loads(body, object_pairs_hook=unique_json)
            if response.status != 200 or not isinstance(result, dict) or set(result) != {'allow', 'authorization'} or type(result['allow']) is not bool: raise RuntimeError('System authorization unavailable')
            if not result['allow']:
                if result['authorization'] is not None: raise RuntimeError('Ambiguous system authorization')
                return None
            return result['authorization']

    async def deliver_one(self, row):
        from Crypto.Cipher import AES
        identity, payload, nonce, tag, expires, attempts = row
        try:
            async with self.bridge.matrix_lock:
                self.bridge.reload_configuration()
                current = self.bridge.db.execute('SELECT status FROM system_deliveries WHERE id=?', (identity,)).fetchone()
                if not current or current[0] != 'pending': return
                if expires <= int(time.time() * 1000) or configured_key(self.bridge.config, self.directory) is None:
                    self.finish(identity, 'cancelled'); return
                cipher = AES.new(self.bridge.queue_key, AES.MODE_GCM, nonce=nonce); cipher.update(('system\n' + identity).encode())
                data = json.loads(cipher.decrypt_and_verify(payload, tag), object_pairs_hook=unique_json)
                if not valid_delivery(data): raise RuntimeError('Invalid persisted system notice')
                permission = await self.authorize(identity)
                if permission is None: self.finish(identity, 'cancelled'); return
                if not valid_authorization(permission, data['source']): raise RuntimeError('Invalid system notice scope')
                if (permission['botUserId'], permission['botDeviceId']) != (self.bridge.client.user_id, self.bridge.client.device_id): raise RuntimeError('System notice bot identity changed')
                event = await self.bridge.send_system_notice(identity, data['source'], permission, self.authorize)
                if event is None: self.finish(identity, 'cancelled')
                elif identifier(event, '$'): self.finish(identity, 'sent', event)
                else: raise RuntimeError('Unconfirmed encrypted system notice')
        except Exception:
            with self.bridge.db:
                self.bridge.db.execute("UPDATE system_deliveries SET attempts=attempts+1,next_attempt=? WHERE id=? AND status='pending'", (int(time.time() * 1000) + min(300, 2 ** min(attempts + 1, 8)) * 1000, identity))

    async def deliver(self):
        while True:
            row = self.bridge.db.execute("SELECT id,payload,nonce,tag,expires,attempts FROM system_deliveries WHERE status='pending' AND next_attempt<=? ORDER BY next_attempt LIMIT 1", (int(time.time() * 1000),)).fetchone()
            if row: await self.deliver_one(row)
            else: await asyncio.sleep(1)

    async def close(self):
        if self.http is not None: await self.http.close()
