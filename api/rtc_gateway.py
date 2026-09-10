"""Managed MatrixRTC token and Nginx signaling admission gateway.

Media never passes through this service. Stored leases contain scope identifiers,
not OpenID/JWT credentials. Every signaling connection checks current authority,
including connections using a token refreshed by the self-hosted SFU.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import time
import weakref
from urllib.parse import parse_qs, urlsplit

from aiohttp import ClientError, ClientTimeout, web

try:
    from .server import APIError, body_json
    from .call_moderation import CallModerator, room_alias
    from .room_authority import room_id
    from .rtc_authority import call_authority
    from .call_audio import enabled as audio_enabled
    from .call_audio_permissions import SOURCES, grant_permissions, stored_permissions, project, projected_claims, attenuated, twirp_permissions, observed_permissions
except ImportError:
    from server import APIError, body_json
    from call_moderation import CallModerator, room_alias
    from room_authority import room_id
    from rtc_authority import call_authority
    from call_audio import enabled as audio_enabled
    from call_audio_permissions import SOURCES, grant_permissions, stored_permissions, project, projected_claims, attenuated, twirp_permissions, observed_permissions

SIGNAL_PATHS = frozenset(('/livekit/sfu/rtc', '/livekit/sfu/rtc/validate', '/livekit/sfu/rtc/v1', '/livekit/sfu/rtc/v1/validate'))
CHECK_INTERVAL = 15
MAX_ADMISSIONS = 128
MAX_SESSION_ADMISSIONS = 8
CHECK_WORKERS = 8
CHECK_TIMEOUT = 38
PENDING_AUDIT_INTERVAL = 3600
LOG = logging.getLogger('tavern.api.rtc')
INTERNAL_SFU_URLS = frozenset(('http://livekit:7880', 'ws://livekit:7880'))


def upstream_failure(stage, status, value=None):
    """Keep native tokens, URLs and untrusted upstream error text out of output."""
    denied_status = 403 if status in (400, 401, 403) else 503
    if stage == 'openid':
        code = 'CALL_OPENID_UNAVAILABLE' if denied_status == 503 else 'CALL_OPENID_REJECTED'
        message = ('Matrix OpenID verification returned HTTP ' + str(status) +
                   '. Check that Synapse has its OpenID listener enabled and has been restarted.') if denied_status == 503 else 'Matrix did not accept the call verification token. Rejoin the call to request a fresh token.'
    elif status == 500 and isinstance(value, dict) and value.get('errcode') == 'M_UNKNOWN' and value.get('error') == 'Unable to create room on SFU':
        code = 'CALL_SFU_ROOM_CREATION_FAILED'
        message = 'The token issuer could not create the conference on LiveKit. Check its internal LiveKit URL and shared credentials.'
    elif stage == 'issuer' and status == 401:
        code = 'CALL_ISSUER_OPENID_REJECTED'
        message = 'The token issuer could not verify your Matrix OpenID token. Check public Matrix discovery and OpenID reachability from the calls container.'
    else:
        code = 'CALL_ISSUER_UNAVAILABLE'
        message = 'The call token issuer returned HTTP ' + str(status) + '. Check the call service configuration.'
    LOG.warning('Call authorization failed: stage=%s status=%s category=%s', stage, status, code)
    return APIError(denied_status, message, code)


def constrained_media(snapshot):
    return (any(snapshot.effective[key] for key in ('muted', 'deafened'))
            or not all(snapshot.publication[key] for key in ('speak', 'video', 'screen_share')))


def denied(message='The conference authorization is invalid.', status=403):
    return APIError(status, message, 'CALL_ACCESS_DENIED')


def identifier(value, maximum=512):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise denied()
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate key')
        result[key] = value
    return result


def decode_jwt(token, key, secret, now=None):
    """Strictly authenticate before inspecting scope; errors never reflect JWTs."""
    now = time.time() if now is None else now
    try:
        if not isinstance(token, str) or len(token) > 8192:
            raise ValueError()
        encoded_header, encoded_payload, signature = token.split('.')
        def decode(value):
            return base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
        header = json.loads(decode(encoded_header), object_pairs_hook=unique_object)
        if not isinstance(header, dict) or header.get('alg') != 'HS256' or set(header) - {'alg', 'typ'}:
            raise ValueError()
        expected = hmac.new(secret.encode(), (encoded_header + '.' + encoded_payload).encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(decode(signature), expected):
            raise ValueError()
        value = json.loads(decode(encoded_payload), object_pairs_hook=unique_object)
        if (not isinstance(value, dict) or value.get('iss') != key
                or type(value.get('exp')) is not int or value['exp'] <= now
                or type(value.get('nbf')) is not int or value['nbf'] > now + 5):
            raise ValueError()
        video = value.get('video')
        if (not isinstance(video, dict) or video.get('roomJoin') is not True
                or any(video.get(name) for name in ('roomAdmin', 'roomCreate', 'roomList', 'roomRecord', 'ingressAdmin'))):
            raise ValueError()
        identifier(value.get('sub')); identifier(video.get('room'))
        return value
    except (ValueError, TypeError, UnicodeError):
        raise denied() from None


def modern_identity(user, device, member):
    # Exact Go json.Marshal escaping used by lk-jwt-service v0.6.0.
    value = json.dumps([user, device, member], ensure_ascii=False, separators=(',', ':'))
    for source, target in (('&', '\\u0026'), ('<', '\\u003c'), ('>', '\\u003e'), ('\u2028', '\\u2028'), ('\u2029', '\\u2029')):
        value = value.replace(source, target)
    return base64.b64encode(hashlib.sha256(value.encode()).digest()).decode().rstrip('=')


def sign_claims(claims, secret):
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).decode().rstrip('=')
    message = encode({'alg': 'HS256', 'typ': 'JWT'}) + '.' + encode(claims)
    return message + '.' + base64.urlsafe_b64encode(hmac.new(secret.encode(), message.encode(), hashlib.sha256).digest()).decode().rstrip('=')


def token_scope(data, session, protocol):
    if protocol == 'legacy':
        allowed = {'room', 'device_id', 'openid_token', 'delay_id', 'delay_timeout', 'delay_cs_api_url'}
        identity, member = room_id(data.get('room')), ''
        device = identifier(data.get('device_id'))
        sfu_identity = session['user_id'] + ':' + device
    else:
        allowed = {'room_id', 'slot_id', 'member', 'openid_token', 'delay_id', 'delay_timeout', 'delay_cs_api_url'}
        identity = room_id(data.get('room_id'))
        value = data.get('member')
        if not isinstance(value, dict) or set(value) != {'id', 'claimed_user_id', 'claimed_device_id'} or value['claimed_user_id'] != session['user_id'] or data.get('slot_id') != 'm.call#ROOM':
            raise denied()
        device, member = identifier(value['claimed_device_id']), identifier(value['id'])
        sfu_identity = modern_identity(session['user_id'], device, member)
    if set(data) - allowed or device != session['device_id']:
        raise denied()
    openid = data.get('openid_token')
    if (not isinstance(openid, dict) or set(openid) != {'access_token', 'token_type', 'matrix_server_name', 'expires_in'}
            or openid.get('token_type') != 'Bearer' or openid.get('matrix_server_name') != session['user_id'].split(':', 1)[1]
            or type(openid.get('expires_in')) is not int or not 0 < openid['expires_in'] <= 86400):
        raise denied()
    identifier(openid['access_token'], 4096)
    # Delayed leave IDs are bearer capabilities; never accept a caller-selected
    # discovery URL or log/retain these request fields.
    delay = {name for name in ('delay_id', 'delay_timeout', 'delay_cs_api_url') if name in data}
    if delay and delay != {'delay_id', 'delay_timeout', 'delay_cs_api_url'}:
        raise denied()
    if delay:
        identifier(data['delay_id'], 512)
        if type(data['delay_timeout']) is not int or not 0 < data['delay_timeout'] <= 86400000:
            raise denied()
    return identity, sfu_identity, member


class SessionRequest(dict):
    path = '/api/calls/sfu-authorize'
    def __init__(self, session):
        super().__init__(session=session)
        self.headers = {'X-Tavern-Device': session['device_id']}


class RtcGateway:
    def __init__(self, service):
        self.service = service
        self.moderator = CallModerator(service)
        self.locks = weakref.WeakValueDictionary()
        service.store.db.executescript('''
            CREATE TABLE IF NOT EXISTS rtc_admissions(
                room_alias TEXT NOT NULL,identity TEXT NOT NULL,room_id TEXT NOT NULL,
                user_id TEXT NOT NULL,device_id TEXT NOT NULL,member_id TEXT NOT NULL,
                session_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
                created REAL NOT NULL,expires REAL NOT NULL,admitted REAL NOT NULL DEFAULT 0,
                next_check REAL NOT NULL DEFAULT 0,last_pending_audit REAL NOT NULL DEFAULT 0,
                PRIMARY KEY(room_alias,identity));
            CREATE INDEX IF NOT EXISTS rtc_admission_check ON rtc_admissions(admitted,next_check);
        ''')
        columns = {row[1] for row in service.store.db.execute('PRAGMA table_info(rtc_admissions)')}
        for name, declaration in (('audio_baseline', "TEXT NOT NULL DEFAULT ''"), ('audio_revision', "TEXT NOT NULL DEFAULT ''"),
                                  ('audio_checked', 'REAL NOT NULL DEFAULT 0'), ('audio_pending', 'INTEGER NOT NULL DEFAULT 0'),
                                  ('audio_rejoin', 'INTEGER NOT NULL DEFAULT 0'), ('audio_last_muted', 'INTEGER NOT NULL DEFAULT -1')):
            if name not in columns:
                service.store.db.execute('ALTER TABLE rtc_admissions ADD COLUMN ' + name + ' ' + declaration)

    def lock(self, alias, identity):
        return self.locks.setdefault((alias, identity), asyncio.Lock())

    async def authority(self, session, identity):
        try:
            async with asyncio.timeout(12):
                native = await self.service.matrix('GET', '/_matrix/client/v3/account/whoami', token=self.service.store.open(session['token']))
                if native.get('user_id') != session['user_id'] or native.get('device_id') != session['device_id']:
                    raise denied()
                return await call_authority(self.service, session, identity)
        except (ClientError, asyncio.TimeoutError):
            raise denied('The current conference permissions could not be checked.', 503) from None

    async def json_request(self, method, url, *, stage='issuer', **kwargs):
        if stage not in ('issuer', 'openid'):
            raise ValueError('Unknown call authorization stage')
        try:
            async with self.service.http.request(method, url, allow_redirects=False, timeout=ClientTimeout(total=8), **kwargs) as response:
                raw = bytearray()
                async for chunk in response.content.iter_chunked(8192):
                    raw.extend(chunk)
                    if len(raw) > 65536:
                        raise denied('The call service response could not be verified.', 503)
                if response.status != 200:
                    try:
                        value = json.loads(raw, object_pairs_hook=unique_object)
                    except (ValueError, UnicodeError):
                        value = None
                    raise upstream_failure(stage, response.status, value)
                value = json.loads(raw, object_pairs_hook=unique_object)
                if not isinstance(value, dict):
                    raise denied('The call service response could not be verified.', 503)
                return value
        except (ClientError, asyncio.TimeoutError, ValueError, UnicodeError):
            message = 'Matrix OpenID verification is temporarily unavailable.' if stage == 'openid' else 'The call token issuer is temporarily unavailable.'
            LOG.warning('Call authorization transport failed: stage=%s', stage)
            raise denied(message, 503) from None

    async def token(self, request):
        service = self.service
        session = service.require_session(request)
        key, secret = self.moderator.credentials()
        data = await body_json(request)
        service.require_session(request)
        method = request.match_info['method']
        if method not in ('get_token', 'sfu/get'):
            raise denied()
        protocol = 'legacy' if method == 'sfu/get' else 'modern'
        identity, sfu_identity, member = token_scope(data, session, protocol)
        if 'delay_cs_api_url' in data and data['delay_cs_api_url'] not in (service.config.public_url, service.config.public_url + '/api/matrix'):
            raise denied()
        service.store.rate('rtc-token:' + session['user_id'], 20, 60)
        # The origin is deployment-controlled, never OpenID discovery input.
        native = await self.json_request('GET', service.config.synapse_url + '/_matrix/federation/v1/openid/userinfo', stage='openid', params={'access_token': data['openid_token']['access_token']})
        if native.get('sub') != session['user_id']:
            raise denied()
        service.require_session(request)
        await self.authority(session, identity)
        service.require_session(request)
        # Keep compatibility delegation inside the trusted deployment. The
        # pinned issuer resolves this homeserver; it never sees an arbitrary URL.
        result = await self.json_request('POST', 'http://rtc-auth:8080/' + method, json=data)
        claims = decode_jwt(result.get('jwt'), key, secret)
        alias = room_alias(identity)
        public_sfu_url = service.config.public_url.replace('https://', 'wss://', 1) + '/livekit/sfu'
        # v0.6.0 uses LIVEKIT_URL for both private CreateRoom RPCs and its response.
        # Accept only this stack's fixed internal SFU or the exact legacy public
        # address. Browsers always receive the authenticated public signaling URL.
        issuer_url = result.get('url')
        if not isinstance(issuer_url, str) or issuer_url not in INTERNAL_SFU_URLS | {public_sfu_url} or claims['sub'] != sfu_identity or claims['video']['room'] != alias:
            raise denied('The call service returned an unexpected conference scope.', 503)
        try:
            baseline = grant_permissions(claims['video'])
        except ValueError:
            raise denied('The call service returned unsupported media permissions.', 503) from None
        async with self.lock(alias, sfu_identity):
            service.require_session(request)
            # Probe before the final native state read so this network await
            # cannot retain an earlier restriction snapshot.
            support = False
            if audio_enabled():
                try:
                    support = await self.moderator.audio_support()
                except APIError:
                    pass
            authority = await self.authority(session, identity)
            service.require_session(request)
            audio = authority.audio
            constrained = constrained_media(audio)
            if constrained and not support:
                raise denied('The running SFU audio restrictions could not be verified.', 503)
            permission = project(baseline, audio.effective['muted'], audio.effective['deafened'], audio.publication)
            token = sign_claims(projected_claims(claims, permission), secret) if constrained else result['jwt']
            now, db = time.time(), service.store.db
            existing = db.execute('SELECT * FROM rtc_admissions WHERE room_alias=? AND identity=?', (alias, sfu_identity)).fetchone()
            if existing and (existing['room_id'], existing['user_id'], existing['device_id'], existing['member_id']) != (identity, session['user_id'], session['device_id'], member):
                raise denied('The conference identity is ambiguous.', 503)
            if db.execute('SELECT count(*) FROM rtc_admissions').fetchone()[0] >= MAX_ADMISSIONS and not db.execute('SELECT 1 FROM rtc_admissions WHERE room_alias=? AND identity=?', (alias, sfu_identity)).fetchone():
                raise denied('The conference admission limit was reached. Try again after a call ends.', 503)
            if not existing and db.execute('SELECT count(*) FROM rtc_admissions WHERE session_id=?', (session['id'],)).fetchone()[0] >= MAX_SESSION_ADMISSIONS:
                raise denied('This browser has too many pending conference connections. Wait briefly and try again.', 429)
            db.execute('''INSERT INTO rtc_admissions(room_alias,identity,room_id,user_id,device_id,member_id,session_id,created,expires,audio_baseline,audio_pending,audio_last_muted)
                VALUES(?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(room_alias,identity) DO UPDATE SET
                session_id=excluded.session_id,expires=excluded.expires,revision=rtc_admissions.revision+1,
                audio_baseline=excluded.audio_baseline,audio_pending=1,audio_checked=0,audio_revision='',audio_rejoin=0,
                audio_last_muted=excluded.audio_last_muted,next_check=0''',
                (alias, sfu_identity, identity, session['user_id'], session['device_id'], member, session['id'], now, session['expires'], json.dumps(baseline, separators=(',', ':')),
                 int(audio.effective['muted'])))
        return web.json_response({'url': public_sfu_url, 'jwt': token}, headers={'Cache-Control': 'no-store'})

    async def authorize(self, request):
        service = self.service
        session = service.require_session(request)
        key, secret = self.moderator.credentials()
        service.store.rate('rtc-signal:' + session['id'], 60, 60)
        original = request.headers.get('X-Tavern-RTC-URI', '')
        uri = urlsplit(original)
        if len(original) > 16384 or uri.scheme or uri.netloc or uri.fragment or uri.path not in SIGNAL_PATHS or request.headers.get('X-Tavern-RTC-Method') != 'GET':
            raise denied()
        if not uri.path.endswith('/validate') and request.headers.get('Origin') != service.config.public_url:
            raise denied()
        try:
            query = parse_qs(uri.query, keep_blank_values=True, max_num_fields=64)
        except ValueError:
            raise denied() from None
        # LiveKit's legacy publish-only query appends an arbitrary suffix to
        # the JWT identity. That would escape this exact identity registry and
        # its disconnect checks. The embedded client does not use this mode.
        if 'publish' in query:
            raise denied()
        values = query.get('access_token', [])
        header = request.headers.get('Authorization', '')
        if header:
            if values or not header.startswith('Bearer '):
                raise denied()
            values = [header[7:]]
        if len(values) != 1:
            raise denied()
        claims = decode_jwt(values[0], key, secret)
        alias, identity = claims['video']['room'], claims['sub']
        async with self.lock(alias, identity):
            service.require_session(request)
            row = service.store.db.execute('SELECT * FROM rtc_admissions WHERE room_alias=? AND identity=?', (alias, identity)).fetchone()
            if not row or row['expires'] <= time.time() or (row['session_id'], row['user_id'], row['device_id']) != (session['id'], session['user_id'], session['device_id']):
                raise denied()
            support = False
            if audio_enabled():
                try:
                    support = await self.moderator.audio_support()
                except APIError:
                    pass
            authority = await self.authority(session, row['room_id'])
            service.require_session(request)
            try:
                flags = authority.audio.effective
                if constrained_media(authority.audio) and not support:
                    raise denied('The running SFU audio restrictions could not be verified.', 503)
                candidate = grant_permissions(claims['video'])
                # Old deployments have no safe baseline to restore; only an
                # unrestricted pre-upgrade connection can use that old row.
                if not row['audio_baseline']:
                    if constrained_media(authority.audio):
                        raise denied()
                else:
                    baseline = stored_permissions(json.loads(row['audio_baseline']))
                    if not attenuated(candidate, project(baseline, flags['muted'], flags['deafened'], authority.audio.publication)):
                        raise denied('This call token predates current audio permissions. Rejoin the call.')
            except (ValueError, TypeError):
                raise denied() from None
            if not uri.path.endswith('/validate'):
                service.store.db.execute('UPDATE rtc_admissions SET admitted=?,next_check=? WHERE room_alias=? AND identity=?', (time.time(), time.time() + CHECK_INTERVAL, alias, identity))
        return web.Response(status=204, headers={'Cache-Control': 'no-store'})

    def session_context(self, row):
        service = self.service
        session = service.store.db.execute('SELECT * FROM sessions WHERE id=?', (row['session_id'],)).fetchone()
        if not session:
            return None
        try:
            context = SessionRequest(dict(session))
            service.require_session(context)
            return context
        except APIError:
            return None

    async def current(self, row):
        return await self.current_authority(row) is not None

    async def current_authority(self, row):
        context = self.session_context(row)
        if context is None:
            return None
        try:
            authority = await self.authority(context['session'], row['room_id'])
            self.service.require_session(context)
            return authority
        except (APIError, ClientError, asyncio.TimeoutError):
            # Missing native authority is insufficient to keep a connection.
            return None

    async def enforce_audio(self, row, authority, participant):
        """Full permission update plus a fresh observed native/SFU confirmation."""
        db, alias, identity = self.service.store.db, row['room_alias'], row['identity']
        flags, snapshot = authority.audio.effective, authority.audio
        if not row['audio_baseline']:
            if constrained_media(snapshot):
                return False  # Safe restoration needs a fresh managed token.
            return True
        try:
            baseline = stored_permissions(json.loads(row['audio_baseline']))
            desired = project(baseline, flags['muted'], flags['deafened'], snapshot.publication)
        except (ValueError, TypeError):
            return False
        if not audio_enabled():
            # Restrictions cannot be ignored because the deployment flag changed.
            return not constrained_media(snapshot)
        try:
            await self.moderator.audio_support()
        except APIError:
            return not constrained_media(snapshot)
        # Recheck after the capability lookup, including native availability.
        fresh = await self.current_authority(row)
        if fresh is None:
            return False
        if fresh.audio.revision != snapshot.revision:
            raise denied('Audio restrictions changed during enforcement.', 503)
        try:
            observed = observed_permissions(participant.get('permission'), require_extension=False)
        except ValueError:
            # Unknown fields/versioned semantics cannot be dropped by a full
            # permission replacement. Disconnect this bound identity instead.
            return False
        # Full Twirp replacement is required by the pinned protocol. Preserve
        # current fields unrelated to these two controls rather than changing
        # them back to an earlier issuer grant during an audio update.
        for name in set(desired) - {'canPublish', 'canPublishSources', 'tavernCanSubscribeAudio'}:
            desired[name] = observed[name]
        clearing_mute = not flags['muted'] and (row['audio_last_muted'] == 1 or row['audio_last_muted'] == -1 and bool(flags['sources']))
        # Retain the policy/issuer intent before intersecting the observed
        # ceiling. A former all-sources role denial sets canPublish=false; its
        # later restoration still needs a truthful rejoin warning, even when
        # there was never a moderator mute flag.
        wanted_publish = desired['canPublish']
        wanted_sources = set(desired['canPublishSources'] or SOURCES) if wanted_publish else set()
        rejoin_needed = bool(row['audio_rejoin'] or clearing_mute and wanted_publish and not observed['canPublish'])
        if desired['canPublish'] and not observed['canPublish']:
            # Pinned SetPermission does not increment version for identical
            # external writes. There is no proof that a current global publish
            # denial is still ours. Keep it closed until a fresh managed join.
            desired['canPublish'] = False
        # Same-value external source-mask writes do not increment the pinned
        # participant version either. Never broaden an observed publication
        # mask in place; clearing a mute can require a fresh managed join.
        observed_sources = set(observed['canPublishSources'] or SOURCES)
        ceiling = set(baseline['canPublishSources'] or SOURCES)
        sources = ceiling & observed_sources & wanted_sources
        desired['canPublishSources'] = [] if sources == set(SOURCES) else sorted(sources)
        if not sources:
            desired['canPublish'] = False
        if ((clearing_mute or snapshot.publication['managed'])
                and (wanted_sources - observed_sources or wanted_sources and not observed['canPublish'])):
            rejoin_needed = True
        if flags['muted'] and row['audio_last_muted'] != 1:
            # Retain only that a mute may have been applied through an ambiguous
            # response. This bit permits a rejoin warning, never a grant increase.
            db.execute('UPDATE rtc_admissions SET audio_last_muted=1 WHERE room_alias=? AND identity=? AND revision=?',
                       (alias, identity, row['revision']))
        if observed != desired:
            await self.moderator.sfu('UpdateParticipant', alias, {'identity': identity, 'permission': twirp_permissions(desired)})
        inventory = (await self.moderator.sfu('ListParticipants', alias)).get('participants')
        if not isinstance(inventory, list) or len(inventory) > 1000 or any(not isinstance(item, dict) or not isinstance(item.get('identity'), str) for item in inventory):
            raise denied('Audio enforcement remains unconfirmed.', 503)
        matches = [item for item in inventory if item['identity'] == identity]
        if len(matches) != 1:
            raise denied('Audio enforcement remains unconfirmed.', 503)
        try:
            if observed_permissions(matches[0].get('permission')) != desired:
                raise ValueError()
        except ValueError:
            raise denied('Audio enforcement remains unconfirmed.', 503) from None
        latest = await self.current_authority(row)
        if latest is None:
            return False
        if latest.audio.revision != snapshot.revision:
            raise denied('Audio restrictions changed during enforcement.', 503)
        db.execute('UPDATE rtc_admissions SET audio_revision=?,audio_checked=?,audio_pending=?,audio_rejoin=?,audio_last_muted=? WHERE room_alias=? AND identity=? AND revision=?',
                   (snapshot.revision, time.time(), int(rejoin_needed), int(rejoin_needed), int(flags['muted']), alias, identity, row['revision']))
        return True

    def pending(self, row):
        now = time.time()
        self.service.store.db.execute('UPDATE rtc_admissions SET audio_pending=1 WHERE room_alias=? AND identity=? AND revision=?',
                                      (row['room_alias'], row['identity'], row['revision']))
        if now - row['last_pending_audit'] >= PENDING_AUDIT_INTERVAL:
            self.service.audit('system', 'call.access_check_pending', row['user_id'], row['room_id'])
            self.service.store.db.execute('UPDATE rtc_admissions SET last_pending_audit=? WHERE room_alias=? AND identity=?', (now, row['room_alias'], row['identity']))

    async def check_lease(self, snapshot):
        service, db = self.service, self.service.store.db
        alias, identity = snapshot['room_alias'], snapshot['identity']
        lock = self.lock(alias, identity)
        try:
            await asyncio.wait_for(lock.acquire(), 12)
        except asyncio.TimeoutError:
            row = db.execute('SELECT * FROM rtc_admissions WHERE room_alias=? AND identity=?', (alias, identity)).fetchone()
            if row:
                self.pending(row)
                db.execute('UPDATE rtc_admissions SET next_check=? WHERE room_alias=? AND identity=?', (time.time() + CHECK_INTERVAL, alias, identity))
            return
        try:
            row = db.execute('SELECT * FROM rtc_admissions WHERE room_alias=? AND identity=?', (alias, identity)).fetchone()
            if not row:
                return
            try:
                async with asyncio.timeout(CHECK_TIMEOUT):
                    allowed = self.session_context(row) is not None
                    # The durable binding already proves whose SFU identity this
                    # is. Known local revocation must attempt removal even when
                    # an inventory read is unavailable.
                    present = not allowed
                    if allowed:
                        participants = (await self.moderator.sfu('ListParticipants', alias)).get('participants')
                        if not isinstance(participants, list) or len(participants) > 1000 or any(not isinstance(p, dict) or not isinstance(p.get('identity'), str) for p in participants):
                            raise denied('The call inventory could not be verified.', 503)
                        matches = [p for p in participants if p['identity'] == identity]
                        if len(matches) > 1:
                            raise denied('The call identity inventory is ambiguous.', 503)
                        present = bool(matches)
                        # Check current native/custom authority after inventory,
                        # never retain a result from before that await.
                        authority = await self.current_authority(row) if present else None
                        allowed = authority is not None if present else self.session_context(row) is not None
                        if allowed and present:
                            allowed = await self.enforce_audio(row, authority, matches[0])
                    if present and not allowed:
                        await self.moderator.sfu('RemoveParticipant', alias, {'identity': identity})
                        remaining = (await self.moderator.sfu('ListParticipants', alias)).get('participants')
                        if not isinstance(remaining, list) or any(not isinstance(p, dict) or not isinstance(p.get('identity'), str) or p['identity'] == identity for p in remaining):
                            raise denied('Conference disconnection remains unconfirmed.', 503)
                        service.audit('system', 'call.access_revoked', row['user_id'], row['room_id'])
                        present = False
                    if not present and (not allowed or time.time() - max(row['created'], row['admitted']) > 60):
                        db.execute('DELETE FROM rtc_admissions WHERE room_alias=? AND identity=?', (alias, identity))
                        return
            except (APIError, ClientError, asyncio.TimeoutError):
                # Retain the proven identity for retry; an unavailable SFU is
                # never reported as a successful disconnect.
                self.pending(row)
            except Exception:
                self.pending(row)
                LOG.warning('A conference access check will retry')
            db.execute('UPDATE rtc_admissions SET next_check=? WHERE room_alias=? AND identity=?', (time.time() + CHECK_INTERVAL, alias, identity))
        finally:
            lock.release()

    async def sweep(self):
        rows = self.service.store.db.execute('SELECT * FROM rtc_admissions WHERE next_check<=? ORDER BY next_check LIMIT ?', (time.time(), MAX_ADMISSIONS)).fetchall()
        pending = iter(rows)
        async def worker():
            for row in pending:
                await self.check_lease(row)
        await asyncio.gather(*(worker() for _ in range(min(CHECK_WORKERS, len(rows)))))

    async def run(self):
        while True:
            try:
                self.moderator.credentials()
                await self.sweep()
            except (APIError, ClientError, asyncio.TimeoutError):
                pass
            except Exception:
                LOG.warning('Conference access checks will retry')
            await asyncio.sleep(CHECK_INTERVAL)


def register_routes(app):
    service = app['service']
    gateway = RtcGateway(service)
    service.rtc_gateway = gateway
    app.router.add_post('/api/calls/rtc-auth/{method:get_token|sfu/get}', gateway.token)
    app.router.add_get('/api/calls/sfu-authorize', gateway.authorize)
    async def start(_):
        service.background(gateway.run())
    app.on_startup.append(start)
