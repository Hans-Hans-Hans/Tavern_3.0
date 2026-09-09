"""Opt-in browser push. Native pushers supply events; no plaintext content is stored."""
import asyncio
import hmac
import json
import logging
import os
import re
import secrets
import time

import aiohttp
from aiohttp import web
from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid02

try:
    from .server import APIError, body_json
    from .push_transport import bounded_json, encode64, subscription_value, subscription_hash, send_push
    from .push_policy import eligible
except ImportError:
    from server import APIError, body_json
    from push_transport import bounded_json, encode64, subscription_value, subscription_hash, send_push
    from push_policy import eligible

LOG = logging.getLogger('tavern.api.push')
APP_ID = 'io.tavern.web'
GATEWAY_PATH = '/_matrix/push/v1/notify'
KEY = re.compile(r'[A-Za-z0-9_-]{43}')
TTL = 300
FOREGROUND_TTL = 35


class PushNotifications:
    def __init__(self, service):
        self.service, self.db = service, service.store.db
        enabled = os.environ.get('WEB_PUSH_ENABLED', 'false').lower()
        if enabled not in ('true', 'false'):
            raise ValueError('WEB_PUSH_ENABLED must be true or false.')
        self.enabled = enabled == 'true'
        self.wake = asyncio.Event()
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS push_subscriptions(
                id TEXT PRIMARY KEY,session_id TEXT UNIQUE NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                generation TEXT NOT NULL,key_hash TEXT UNIQUE NOT NULL,endpoint_hash TEXT UNIQUE NOT NULL,
                secret TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,
                credential_epoch REAL NOT NULL,next_check REAL NOT NULL DEFAULT 0,checks INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS push_subscription_expiry ON push_subscriptions(expires);
            CREATE TABLE IF NOT EXISTS push_jobs(
                id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
                room_id TEXT NOT NULL,event_id TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,
                next_attempt REAL NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',
                ticket_hash TEXT UNIQUE NOT NULL,ticket TEXT NOT NULL,
                UNIQUE(subscription_id,event_id));
            CREATE INDEX IF NOT EXISTS push_due ON push_jobs(state,next_attempt);
            CREATE INDEX IF NOT EXISTS push_job_expiry ON push_jobs(expires);
            CREATE TABLE IF NOT EXISTS push_foreground(
                subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
                client_id TEXT NOT NULL,expires REAL NOT NULL,sequence INTEGER NOT NULL,active INTEGER NOT NULL,
                PRIMARY KEY(subscription_id,client_id));
            CREATE INDEX IF NOT EXISTS push_foreground_expiry ON push_foreground(expires);
        ''')
        self.db.execute("UPDATE push_jobs SET state='pending' WHERE state='sending'")
        self.pem, self.public_key = None, None
        if self.enabled:
            pem = service.store.get('web_push_vapid_pem')
            if pem is None:
                if self.db.execute('SELECT 1 FROM push_subscriptions LIMIT 1').fetchone():
                    raise ValueError('Push subscriptions exist but their VAPID key is missing. Restore the account backup.')
                key = Vapid02(); key.generate_keys()
                pem = key.private_pem().decode()
                service.store.set('web_push_vapid_pem', pem)
            key = Vapid02.from_pem(pem.encode())
            self.pem = pem
            self.public_key = encode64(key.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))

    def live(self, subscription):
        row = self.db.execute('SELECT * FROM push_subscriptions WHERE id=? AND generation=?', (subscription['id'], subscription['generation'])).fetchone()
        now = time.time()
        if not self.enabled or not row or row['expires'] <= now:
            raise APIError(401, 'This notification subscription is no longer active.', 'PUSH_EXPIRED')
        session = self.db.execute('SELECT * FROM sessions WHERE id=? AND expires>?', (row['session_id'], now)).fetchone()
        if not session:
            raise APIError(401, 'This notification session expired.', 'PUSH_EXPIRED')
        session = dict(session)
        account = self.service.store.account(session['user_id'])
        policy = self.service.security_policy()
        deadline = session['created'] + (policy['persistentDays'] * 86400 if session['persistent'] else policy['sessionHours'] * 3600)
        if not account or account.get('access_blocked') or account.get('password_change_required') or self.service.deactivations.unavailable(session['user_id']) or account.get('credential_epoch', 0) != row['credential_epoch'] or self.service.needs_mfa_enrollment(session) or deadline <= now:
            raise APIError(401, 'Account security changed. Enable notifications again after signing in.', 'PUSH_EXPIRED')
        return session

    def maintenance(self):
        return bool(self.service.store.get('policy', {}).get('maintenance', {}).get('enabled'))

    def has_foreground(self, row):
        return self.db.execute('SELECT 1 FROM push_foreground WHERE subscription_id=? AND active=1 AND expires>? LIMIT 1', (row['id'], time.time())).fetchone() is not None

    def delivery_live(self, row, job):
        self.live(row)
        if self.maintenance() or job['expires'] <= time.time() or self.has_foreground(row):
            raise APIError(403, 'This notification is no longer eligible.', 'PUSH_SUPPRESSED')

    async def native(self, method, path, body=None, token=None):
        assert path.startswith(('/_matrix/', '/_synapse/admin/'))
        async with asyncio.timeout(6):
            async with self.service.http.request(method, self.service.config.synapse_url + path, json=body,
                    headers={'Authorization': 'Bearer ' + token, 'Accept-Encoding': 'identity'},
                    allow_redirects=False, auto_decompress=False) as response:
                value = await bounded_json(response)
                return response.status, value

    def view(self, row):
        return {'id': row['id'], 'generation': row['generation'], 'expiresAt': int(row['expires'] * 1000),
                'subscriptionHash': subscription_hash(self.service.store.open(row['secret'])['subscription'])}

    def remove(self, row):
        self.db.execute('DELETE FROM push_subscriptions WHERE id=? AND generation=?', (row['id'], row['generation']))

    def revoke_session(self, session_id):
        # Publishing a new cookie retires this browser's previous push owner.
        # Keep the old native device/session available in Devices & Sessions;
        # its orphan native pusher is rejected if it subsequently contacts us.
        self.db.execute('DELETE FROM push_subscriptions WHERE session_id=?', (session_id,))

    async def remove_native(self, token, secret):
        try:
            await self.native('POST', '/_matrix/client/v3/pushers/set', {'app_id': APP_ID, 'pushkey': secret['pushkey'], 'kind': None}, token)
        except Exception:
            # Unknown keys are rejected by the public gateway if native logout
            # could not remove an orphan pusher. Never retain account tokens here.
            LOG.warning('A stale browser pusher could not be removed immediately')

    async def reconcile(self, row):
        session = self.live(row)
        code, value = await self.native('GET', '/_matrix/client/v3/pushers', token=self.service.store.open(session['token']))
        self.live(row)
        pushers = value.get('pushers') if isinstance(value, dict) else None
        if code != 200 or not isinstance(pushers, list) or len(pushers) > 1000:
            raise APIError(502, 'The homeserver notification registration could not be confirmed.')
        secret = self.service.store.open(row['secret'])
        expected = {'url': self.service.config.public_url + GATEWAY_PATH, 'format': 'event_id_only'}
        if any(isinstance(p, dict) and p.get('app_id') == APP_ID and p.get('pushkey') == secret['pushkey'] and p.get('kind') == 'http' and p.get('data') == expected for p in pushers):
            self.db.execute("UPDATE push_subscriptions SET state='active',checks=0 WHERE id=?", (row['id'],))
            return True
        return False

    async def config(self, request):
        session = self.service.require_session(request)
        row = self.db.execute('SELECT * FROM push_subscriptions WHERE session_id=?', (session['id'],)).fetchone()
        current = None
        if self.enabled and row:
            try:
                self.live(row)
                if row['state'] == 'active':
                    current = self.view(row)
            except APIError:
                self.remove(row)
        return web.json_response({'enabled': self.enabled, 'publicKey': self.public_key if self.enabled else None, 'subscription': current})

    async def subscribe(self, request):
        data = await body_json(request, 8192)
        session = self.service.require_session(request)
        if not self.enabled:
            raise APIError(503, 'Background notifications are disabled on this instance.', 'PUSH_DISABLED')
        if set(data) != {'consent', 'subscription'} or data['consent'] is not True:
            raise APIError(400, 'Choose Enable background notifications to subscribe.')
        value = subscription_value(data['subscription'])
        store = self.service.store
        store.rate('push-register:' + session['user_id'], 8, 300)
        async with self.service.user_locks.setdefault(session['user_id'], asyncio.Lock()):
            self.service.require_session(request)
            previous = self.db.execute('SELECT * FROM push_subscriptions WHERE session_id=?', (session['id'],)).fetchone()
            if previous:
                try:
                    self.live(previous)
                except APIError:
                    stale_secret = store.open(previous['secret'])
                    self.remove(previous)
                    self.service.background(self.remove_native(store.open(session['token']), stale_secret))
                    previous = None
            endpoint_hash = store.digest(value['endpoint'])
            other = self.db.execute('SELECT id,session_id FROM push_subscriptions WHERE endpoint_hash=?', (endpoint_hash,)).fetchone()
            if other and other['session_id'] != session['id']:
                raise APIError(409, 'This browser subscription belongs to another session. Unsubscribe in this browser before enabling it again.', 'PUSH_OWNER_CHANGED')
            if not previous and self.db.execute('SELECT count(*) FROM push_subscriptions').fetchone()[0] >= 5000:
                raise APIError(429, 'This instance has reached its browser subscription limit.')
            # Each explicit consent gets a new owner generation. Recovery of a
            # lost native response happens through reconcile(), never POST replay.
            now = time.time()
            identity, generation, pushkey = secrets.token_urlsafe(24), secrets.token_urlsafe(24), secrets.token_urlsafe(32)
            expires = min(session['expires'], value['expirationTime'] / 1000 if value['expirationTime'] else session['expires'])
            old_secret = store.open(previous['secret']) if previous else None
            self.db.execute('BEGIN IMMEDIATE')
            try:
                if previous: self.remove(previous)
                self.db.execute("INSERT INTO push_subscriptions(id,session_id,generation,key_hash,endpoint_hash,secret,state,created,expires,credential_epoch) VALUES(?,?,?,?,?,?,'pending',?,?,?)",
                    (identity, session['id'], generation, store.digest(pushkey), endpoint_hash, store.seal({'subscription': value, 'pushkey': pushkey}), now, expires, store.account(session['user_id']).get('credential_epoch', 0)))
                self.db.execute('COMMIT')
            except BaseException:
                self.db.execute('ROLLBACK'); raise
            if old_secret:
                self.service.background(self.remove_native(store.open(session['token']), old_secret))
            row = self.db.execute('SELECT * FROM push_subscriptions WHERE id=?', (identity,)).fetchone()
            self.live(row)
            secret = store.open(row['secret'])
            payload = {'app_id': APP_ID, 'app_display_name': 'Tavern', 'device_display_name': 'Tavern browser',
                       'pushkey': secret['pushkey'], 'kind': 'http', 'lang': 'en', 'append': False,
                       'data': {'url': self.service.config.public_url + GATEWAY_PATH, 'format': 'event_id_only'}}
            try:
                code, result = await self.native('POST', '/_matrix/client/v3/pushers/set', payload, store.open(session['token']))
                self.live(row); self.service.require_session(request)
                if code != 200 or not isinstance(result, dict) or not await self.reconcile(row):
                    raise APIError(502, 'The homeserver notification registration could not be confirmed.')
            finally:
                self.wake.set()
            self.live(row); self.service.require_session(request)
            return web.json_response(self.view(row), status=201)

    async def unsubscribe(self, request):
        data = await body_json(request, 4096)
        session = self.service.require_session(request)
        if set(data) != {'id', 'generation'} or not all(isinstance(data.get(k), str) and len(data[k]) <= 80 for k in data):
            raise APIError(400, 'Choose the current browser notification subscription.')
        row = self.db.execute('SELECT * FROM push_subscriptions WHERE id=? AND session_id=? AND generation=?', (data['id'], session['id'], data['generation'])).fetchone()
        if row:
            secret = self.service.store.open(row['secret'])
            self.remove(row)
            self.service.background(self.remove_native(self.service.store.open(session['token']), secret))
        return web.json_response({'ok': True})

    async def foreground(self, request):
        data = await body_json(request, 4096)
        session = self.service.require_session(request)
        if set(data) != {'generation', 'clientId', 'sequence', 'active'} or type(data['active']) is not bool or type(data['sequence']) is not int or not 0 <= data['sequence'] <= 9007199254740991 or not isinstance(data['generation'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{32}', data['generation']) or not isinstance(data['clientId'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,64}', data['clientId']):
            raise APIError(400, 'Invalid browser notification lease.')
        row = self.db.execute("SELECT * FROM push_subscriptions WHERE session_id=? AND generation=? AND state='active'", (session['id'], data['generation'])).fetchone()
        if not row:
            raise APIError(409, 'This browser notification owner changed.', 'PUSH_OWNER_CHANGED')
        self.live(row)
        self.service.store.rate('push-foreground:' + session['id'], 120, 60)
        now = time.time()
        self.db.execute('DELETE FROM push_foreground WHERE expires<=?', (now,))
        existing = self.db.execute('SELECT * FROM push_foreground WHERE subscription_id=? AND client_id=?', (row['id'], data['clientId'])).fetchone()
        if existing and existing['sequence'] >= data['sequence']:
            return web.json_response({'ok': True, 'expiresAt': int(existing['expires'] * 1000) if existing['active'] else 0})
        if not existing and self.db.execute('SELECT count(*) FROM push_foreground WHERE subscription_id=?', (row['id'],)).fetchone()[0] >= 16:
            raise APIError(429, 'Too many active browser notification tabs.')
        expires = min(now + FOREGROUND_TTL, row['expires'])
        self.db.execute('INSERT INTO push_foreground(subscription_id,client_id,expires,sequence,active) VALUES(?,?,?,?,?) ON CONFLICT(subscription_id,client_id) DO UPDATE SET expires=excluded.expires,sequence=excluded.sequence,active=excluded.active', (row['id'], data['clientId'], expires, data['sequence'], int(data['active'])))
        return web.json_response({'ok': True, 'expiresAt': int(expires * 1000) if data['active'] else 0})

    async def bind(self, request):
        """Authorize a worker owner against this browser's current cookie/device.

        The worker must still guard its own mutation revision while this response
        is in flight. A response cannot authorize overwriting a newer local owner.
        """
        data = await body_json(request, 4096)
        session = self.service.require_session(request)
        if request.headers.get('X-Tavern-Device') != session['device_id']:
            raise APIError(401, 'This browser notification device changed.', 'PUSH_OWNER_CHANGED')
        generation = data.get('generation')
        if set(data) != {'generation'} or not isinstance(generation, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32}', generation):
            raise APIError(400, 'Invalid browser notification owner.')
        self.service.store.rate('push-bind:' + session['id'], 120, 60)
        row = self.db.execute("SELECT * FROM push_subscriptions WHERE session_id=? AND generation=? AND state='active'", (session['id'], generation)).fetchone()
        if row:
            try:
                self.live(row)
                return web.json_response({'valid': True, 'generation': row['generation'], 'expiresAt': int(row['expires'] * 1000)})
            except APIError:
                pass
        return web.json_response({'valid': False})

    async def notify(self, request):
        self.service.store.rate('push-gateway-global', 1000, 60)
        data = await body_json(request, 32768)
        value = data.get('notification')
        if set(data) != {'notification'} or not isinstance(value, dict) or set(value) - {'event_id', 'room_id', 'counts', 'devices', 'prio'}:
            raise APIError(400, 'Invalid notification envelope.')
        devices = value.get('devices')
        if not isinstance(devices, list) or not 1 <= len(devices) <= 16:
            raise APIError(400, 'Invalid notification devices.')
        counts = value.get('counts', {})
        if not isinstance(counts, dict) or set(counts) - {'unread', 'missed_calls'} or any(type(count) is not int or not 0 <= count <= 2147483647 for count in counts.values()) or value.get('prio', 'high') not in ('high', 'low'):
            raise APIError(400, 'Invalid notification counts or priority.')
        room, event = value.get('room_id'), value.get('event_id')
        def reference(value, prefix):
            return isinstance(value, str) and value.startswith(prefix) and 1 < len(value) <= 255 and not any(ord(c) < 33 or ord(c) == 127 for c in value)
        if event is not None and (not reference(event, '$') or not reference(room, '!')) or event is None and room is not None:
            raise APIError(400, 'Invalid notification event reference.')
        for device in devices:
            if not isinstance(device, dict) or set(device) - {'app_id', 'pushkey', 'pushkey_ts', 'data'} or not isinstance(device.get('pushkey'), str) or not KEY.fullmatch(device['pushkey']) or ('pushkey_ts' in device and (type(device['pushkey_ts']) is not int or not 0 <= device['pushkey_ts'] <= 253402300799)):
                raise APIError(400, 'Invalid notification capability.')
        rejected = []
        for device in devices:
            key = device['pushkey']
            if device.get('app_id') != APP_ID or device.get('data') != {'format': 'event_id_only'}:
                rejected.append(key); continue
            row = self.db.execute('SELECT * FROM push_subscriptions WHERE key_hash=?', (self.service.store.digest(key),)).fetchone()
            try:
                if not row: raise APIError(401, 'Expired')
                self.live(row)
            except APIError:
                if row: self.remove(row)
                rejected.append(key); continue
            if event is None: continue  # Badge-only updates never make an alert.
            if self.db.execute('SELECT 1 FROM push_jobs WHERE subscription_id=? AND event_id=?', (row['id'], event)).fetchone(): continue
            if self.db.execute('SELECT count(*) FROM push_jobs WHERE subscription_id=?', (row['id'],)).fetchone()[0] >= 50 or self.db.execute('SELECT count(*) FROM push_jobs').fetchone()[0] >= 2000:
                continue  # Coalesce a burst instead of queuing unbounded activity.
            ticket, now = secrets.token_urlsafe(32), time.time()
            self.db.execute('INSERT INTO push_jobs(id,subscription_id,room_id,event_id,created,expires,ticket_hash,ticket) VALUES(?,?,?,?,?,?,?,?)',
                (secrets.token_urlsafe(24), row['id'], room, event, now, min(now + TTL, row['expires']), self.service.store.digest(ticket), self.service.store.seal(ticket)))
        self.wake.set()
        return web.json_response({'rejected': rejected})

    async def check(self, request):
        data = await body_json(request, 4096)
        ticket, generation = data.get('ticket'), data.get('generation')
        if set(data) != {'ticket', 'generation'} or not isinstance(ticket, str) or not KEY.fullmatch(ticket) or not isinstance(generation, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32}', generation):
            return web.json_response({'show': False})
        job = self.db.execute('SELECT * FROM push_jobs WHERE ticket_hash=? AND expires>?', (self.service.store.digest(ticket), time.time())).fetchone()
        row = self.db.execute('SELECT * FROM push_subscriptions WHERE id=?', (job['subscription_id'],)).fetchone() if job else None
        show = False
        if row and job['state'] in ('sending', 'sent') and hmac.compare_digest(row['generation'], generation):
            try:
                self.service.store.rate('push-display:' + row['id'], 60, 60)
                async with asyncio.timeout(12):
                    show = await eligible(self, row, job)
                self.live(row)
                show = show and job['expires'] > time.time()
            except (APIError, aiohttp.ClientError, asyncio.TimeoutError):
                show = False
        return web.json_response({'show': bool(show)})

    async def process(self, job):
        row = self.db.execute('SELECT * FROM push_subscriptions WHERE id=?', (job['subscription_id'],)).fetchone()
        if not row: return
        if not self.db.execute("UPDATE push_jobs SET state='sending' WHERE id=? AND state='pending'", (job['id'],)).rowcount: return
        try:
            async with asyncio.timeout(20):
                self.delivery_live(row, job)
                if not await eligible(self, row, job):
                    self.db.execute("UPDATE push_jobs SET state='suppressed' WHERE id=?", (job['id'],)); return
                self.delivery_live(row, job)
                secret = self.service.store.open(row['secret'])
                payload = {'v': 1, 'kind': 'activity', 'generation': row['generation'], 'ticket': self.service.store.open(job['ticket']), 'expiresAt': int(job['expires'] * 1000)}
                async def refresh():
                    self.delivery_live(row, job)
                    if not await eligible(self, row, job):
                        raise APIError(403, 'This notification is no longer eligible.', 'PUSH_SUPPRESSED')
                    self.delivery_live(row, job)
                status, retry = await send_push(secret['subscription'], self.pem, self.service.config.public_url, payload, job['expires'] - time.time(), lambda: self.delivery_live(row, job), refresh)
                self.live(row)
                if status in (404, 410):
                    self.remove(row); return
                if 200 <= status < 300:
                    self.db.execute("UPDATE push_jobs SET state='sent' WHERE id=?", (job['id'],)); return
                if status not in (408, 429) and status < 500:
                    self.db.execute("UPDATE push_jobs SET state='suppressed' WHERE id=?", (job['id'],)); return
                raise APIError(503, 'The browser push provider will be retried.', retryAfter=retry)
        except APIError as error:
            if error.code == 'PUSH_EXPIRED':
                self.remove(row); return
            if error.code == 'PUSH_SUPPRESSED':
                self.db.execute("UPDATE push_jobs SET state='suppressed' WHERE id=?", (job['id'],)); return
            retry = error.details.get('retryAfter', 0)
        except (aiohttp.ClientError, asyncio.TimeoutError):
            retry = 0
        except Exception:
            LOG.error('A browser notification could not be delivered')
            retry = 0
        attempts = job['attempts'] + 1
        self.db.execute("UPDATE push_jobs SET state=?,attempts=?,next_attempt=? WHERE id=?", ('suppressed' if attempts >= 4 else 'pending', attempts, time.time() + max(retry, min(120, 5 * 2 ** attempts)), job['id']))

    async def process_once(self):
        now = time.time()
        self.db.execute('DELETE FROM push_jobs WHERE expires<=?', (now,))
        self.db.execute('DELETE FROM push_foreground WHERE expires<=?', (now,))
        self.db.execute('DELETE FROM push_subscriptions WHERE expires<=? OR session_id IN (SELECT id FROM sessions WHERE expires<=?)', (now, now))
        if not self.enabled:
            self.db.execute('DELETE FROM push_subscriptions'); return
        for row in self.db.execute("SELECT * FROM push_subscriptions WHERE state='pending' AND next_check<=? LIMIT 10", (now,)).fetchall():
            try:
                if await self.reconcile(row): continue
            except (APIError, aiohttp.ClientError, asyncio.TimeoutError):
                pass
            if row['checks'] >= 3:
                self.remove(row)
            else:
                self.db.execute('UPDATE push_subscriptions SET checks=checks+1,next_check=? WHERE id=?', (time.time() + 15, row['id']))
        jobs = self.db.execute("SELECT j.* FROM push_jobs j JOIN push_subscriptions s ON s.id=j.subscription_id WHERE j.state='pending' AND s.state='active' AND j.next_attempt<=? ORDER BY j.created,j.id LIMIT 2", (time.time(),)).fetchall()
        await asyncio.gather(*(self.process(job) for job in jobs))

    async def run(self):
        while True:
            self.wake.clear()
            try:
                await self.process_once()
            except Exception:
                LOG.error('Browser notification maintenance will retry')
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=15)
            except asyncio.TimeoutError:
                pass


def register_routes(app):
    service = app['service']
    service.push = manager = PushNotifications(service)
    app.add_routes([web.get('/api/push/config', manager.config), web.post('/api/push/subscription', manager.subscribe),
                    web.delete('/api/push/subscription', manager.unsubscribe), web.post('/api/push/check', manager.check),
                    web.post('/api/push/foreground', manager.foreground),
                    web.post('/api/push/bind', manager.bind),
                    web.post(GATEWAY_PATH, manager.notify)])
    async def start(_):
        service.background(manager.run())
    app.on_startup.append(start)
