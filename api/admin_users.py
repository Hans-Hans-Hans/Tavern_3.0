"""Bounded account inventory and explicit, serialized account administration."""
import asyncio
import re
import time
from urllib.parse import quote, urlencode

from aiohttp import web

try:
    from .server import APIError, body_json, text_value
    from .security import password_error
    from .admin_resources import limits
except ImportError:
    from server import APIError, body_json, text_value
    from security import password_error
    from admin_resources import limits

NATIVE_FIELDS = ('name', 'displayname', 'avatar_url', 'admin', 'deactivated', 'locked', 'suspended', 'creation_ts', 'last_seen_ts', 'user_type')


def identity(value):
    if not isinstance(value, str) or not re.fullmatch(r'@[^\s:]{1,128}:[^\s]{1,255}', value):
        raise APIError(400, 'Choose a valid Matrix account.')
    return value


def public_security(service, target):
    account = service.store.account(target)
    return {'managed': bool(account), 'email': account.get('email'), 'emailVerified': bool(account.get('verified')),
            'mfaMethods': service.methods(account), 'passwordChangeRequired': bool(account.get('password_change_required')),
            'accessBlocked': account.get('access_blocked', '')}


def native_user(value):
    return {name: value.get(name) for name in NATIVE_FIELDS}


def pick(request, key, choices, default):
    value = request.query.get(key, default)
    if value not in choices:
        raise APIError(400, 'Choose valid account filters.')
    return value


async def listing(request):
    service = request.app['service']; session = await service.require_admin(request)
    start = request.query.get('from', '0')
    if not re.fullmatch(r'[0-9]{1,12}', start):
        raise APIError(400, 'Invalid account page.')
    role = pick(request, 'role', ('all', 'admin', 'user'), 'all')
    status = pick(request, 'status', ('all', 'active', 'locked', 'deactivated'), 'all')
    mfa = pick(request, 'mfa', ('all', 'enabled', 'disabled', 'unmanaged'), 'all')
    email = pick(request, 'email', ('all', 'verified', 'unverified', 'unset', 'unmanaged'), 'all')
    sort = pick(request, 'sort', ('name', 'creation_ts'), 'name')
    direction = pick(request, 'dir', ('f', 'b'), 'f')
    query = {'limit': '50', 'from': start, 'name': text_value(request.query.get('search', ''), 200), 'locked': 'true', 'order_by': sort, 'dir': direction}
    if role != 'all': query['admins'] = 'true' if role == 'admin' else 'false'
    if status == 'deactivated': query['deactivated'] = 'true'
    elif status in ('active', 'locked'): query['deactivated'] = 'false'
    value = await service.matrix('GET', '/_synapse/admin/v3/users?' + urlencode(query), token=service.store.open(session['token']))
    result = []
    for row in value.get('users', [])[:50]:
        target = row.get('name', '')
        metadata = public_security(service, target)
        account = service.store.account(target)
        if status == 'locked' and not row.get('locked'): continue
        if status == 'active' and (row.get('locked') or row.get('suspended') or account.get('access_blocked')): continue
        actual_mfa = ('enabled' if metadata['mfaMethods'] else 'disabled') if account else 'unmanaged'
        actual_email = ('verified' if metadata['emailVerified'] else 'unverified') if account.get('email') else 'unset' if account else 'unmanaged'
        if mfa != 'all' and mfa != actual_mfa: continue
        if email != 'all' and email != actual_email: continue
        result.append({**native_user(row), 'security': metadata, 'serviceAccount': target == service.store.get('service_account', {}).get('userId')})
    locally_filtered = status in ('active', 'locked') or mfa != 'all' or email != 'all'
    return web.json_response({'users': result, 'next_token': value.get('next_token'), 'total': None if locally_filtered else value.get('total'),
                              'scanned': len(value.get('users', [])), 'totalBeforeLocalFilters': value.get('total'), 'boundedPageFiltering': locally_filtered})


async def detail(request):
    service = request.app['service']; session = await service.require_admin(request)
    target, token = identity(request.match_info['user_id']), service.store.open(session['token'])
    user, membership = await asyncio.gather(service.matrix('GET', '/_synapse/admin/v2/users/' + quote(target, safe=''), token=token),
                                           service.matrix('GET', '/_synapse/admin/v1/users/' + quote(target, safe='') + '/joined_rooms', token=token))
    rooms_from, sessions_from = max(0, int(request.query.get('roomsFrom', '0'))), max(0, int(request.query.get('sessionsFrom', '0')))
    db = service.store.db
    count = db.execute('SELECT count(*) FROM sessions WHERE user_id=? AND expires>?', (target, time.time())).fetchone()[0]
    rows = db.execute('SELECT id,device_id,name,created,last_seen,expires,ip FROM sessions WHERE user_id=? AND expires>? ORDER BY last_seen DESC,id LIMIT 50 OFFSET ?', (target, time.time(), sessions_from)).fetchall()
    sessions = [{'id': row['id'], 'deviceId': row['device_id'], 'name': row['name'], 'createdAt': int(row['created'] * 1000), 'lastSeen': int(row['last_seen'] * 1000), 'expiresAt': int(row['expires'] * 1000), 'ip': row['ip']} for row in rows]
    rooms = membership.get('joined_rooms', [])
    usage = db.execute('SELECT bytes FROM upload_usage WHERE user_id=?', (target,)).fetchone()
    initialized = bool(service.store.get('upload_usage_initialized'))
    quota = service.store.account(target).get('upload_quota_bytes') or limits(service)['userQuotaBytes']
    audit = db.execute('SELECT id,created,actor,action,target,detail FROM audit WHERE actor=? OR target=? ORDER BY id DESC LIMIT 20', (target, target)).fetchall()
    return web.json_response({'user': native_user(user), 'security': public_security(service, target), 'serviceAccount': target == service.store.get('service_account', {}).get('userId'),
                              'sessions': {'items': sessions, 'total': count, 'next': sessions_from + 50 if sessions_from + 50 < count else None},
                              'rooms': {'items': rooms[rooms_from:rooms_from + 50], 'total': len(rooms), 'next': rooms_from + 50 if rooms_from + 50 < len(rooms) else None},
                              'storage': {'usedBytes': (usage[0] if usage else 0) if initialized else None, 'quotaBytes': quota, 'quotaOverrideBytes': service.store.account(target).get('upload_quota_bytes'), 'usageInitialized': initialized,
                                          'uncertainReservations': db.execute("SELECT count(*) FROM upload_reservations WHERE user_id=? AND state='reserved'", (target,)).fetchone()[0]}, 'audit': [dict(row) for row in audit]})


def protect(service, session, target, sensitive=True):
    if target == service.store.get('service_account', {}).get('userId'):
        raise APIError(400, 'The account service identity is managed by Tavern.')
    if sensitive and target == session['user_id']:
        raise APIError(400, 'Use your own account settings, or another administrator for changes to your administrator access.')


async def active_admin(request):
    service = request.app['service']
    session = await service.require_admin(request)
    current = await service.matrix('GET', '/_synapse/admin/v2/users/' + quote(session['user_id'], safe=''), token=service.store.open(session['token']))
    if current.get('admin') is not True or any(current.get(flag) for flag in ('locked', 'deactivated', 'suspended')):
        raise APIError(403, 'An active, unrestricted administrator must perform account access changes.', 'FORBIDDEN')
    return session


async def revoke_devices(service, target, token):
    path = '/_synapse/admin/v2/users/' + quote(target, safe='')
    value = await service.matrix('GET', path + '/devices', token=token)
    devices = [row['device_id'] for row in value.get('devices', []) if isinstance(row.get('device_id'), str)]
    # The native device list is unpaginated. Bound each mutation's payload.
    for offset in range(0, len(devices), 100):
        await service.matrix('POST', path + '/delete_devices', {'devices': devices[offset:offset + 100]}, token)
    count = service.store.db.execute('DELETE FROM sessions WHERE user_id=?', (target,)).rowcount
    service.store.db.execute('DELETE FROM challenges WHERE user_id=?', (target,))
    service.store.db.execute('UPDATE accounts SET credential_epoch=? WHERE user_id=?', (time.time(), target))
    return {'sessionsRevoked': count, 'nativeDevicesRevoked': len(devices)}


async def actions(request):
    service = request.app['service']; target = identity(request.match_info['user_id']); data = await body_json(request)
    operation = data.get('action')
    if operation not in ('revoke_sessions', 'reset_mfa', 'require_password_change', 'suspend', 'enable', 'deactivate', 'set_quota') or data.get('confirmation') != target:
        raise APIError(400, 'Choose an account action and type the full Matrix user ID to confirm.')
    async with service.admin_lock:
        session = await active_admin(request)
        protect(service, session, target)
        # Do not lock actor and target simultaneously: account settings already
        # hold the actor lock. Verify credentials first, then serialize target.
        async with service.user_locks.setdefault(session['user_id'], asyncio.Lock()):
            await service.require_sensitive(request, data)
        async with service.user_locks.setdefault(target, asyncio.Lock()):
            session = await active_admin(request)
            token = service.store.open(session['token'])
            user = await service.matrix('GET', '/_synapse/admin/v2/users/' + quote(target, safe=''), token=token)
            db = service.store.db
            db.execute('INSERT OR IGNORE INTO accounts(user_id,created) VALUES(?,?)', (target, time.time()))
            result = {'ok': True}
            if operation == 'set_quota':
                quota = data.get('quotaBytes')
                if quota is not None and (type(quota) is not int or not 1024 <= quota <= limits(service)['globalQuotaBytes']):
                    raise APIError(400, 'Choose a quota between 1024 bytes and the instance quota, or reset it to the default.')
                db.execute('UPDATE accounts SET upload_quota_bytes=? WHERE user_id=?', (quota, target))
            elif operation == 'enable':
                if user.get('deactivated'):
                    error = service.password_error(data.get('newPassword'))
                    if error: raise APIError(400, error)
                    await service.matrix('PUT', '/_synapse/admin/v2/users/' + quote(target, safe=''), {'deactivated': False, 'locked': False, 'password': data['newPassword'], 'logout_devices': True}, token)
                    db.execute('UPDATE accounts SET password_change_required=1 WHERE user_id=?', (target,))
                else:
                    await service.matrix('PUT', '/_synapse/admin/v2/users/' + quote(target, safe=''), {'locked': False}, token)
                await service.matrix('PUT', '/_synapse/admin/v1/suspend/' + quote(target, safe=''), {'suspend': False}, token)
                db.execute("UPDATE accounts SET access_blocked='' WHERE user_id=?", (target,))
            else:
                # Persist fail-closed restrictions before any upstream await.
                if operation in ('reset_mfa', 'require_password_change'):
                    db.execute('UPDATE accounts SET password_change_required=1 WHERE user_id=?', (target,))
                if operation in ('suspend', 'deactivate'):
                    db.execute('UPDATE accounts SET access_blocked=? WHERE user_id=?', (operation, target))
                result.update(await revoke_devices(service, target, token))
                if operation == 'reset_mfa':
                    db.execute('UPDATE accounts SET totp=NULL,email_mfa=0,totp_counter=-1 WHERE user_id=?', (target,))
                    db.execute('DELETE FROM recovery_codes WHERE user_id=?', (target,))
                elif operation == 'suspend':
                    await service.matrix('PUT', '/_synapse/admin/v1/suspend/' + quote(target, safe=''), {'suspend': True}, token)
                elif operation == 'deactivate':
                    await service.matrix('POST', '/_synapse/admin/v1/deactivate/' + quote(target, safe=''), {'erase': False}, token)
            service.audit(session['user_id'], 'security_admin_' + operation, target)
            service.background(service.security_notice(target, 'Administrator account action', 'An administrator performed this action on your Tavern account: ' + operation.replace('_', ' ') + '. Contact your administrator if you did not expect this. Encrypted history is never decrypted by account administration.'))
            return web.json_response(result)


async def update(request):
    service = request.app['service']; data = await body_json(request); target = identity(request.match_info['user_id'])
    allowed = {key: value for key, value in data.items() if key in ('displayname', 'admin', 'locked')}
    if not allowed or any(type(value) is not bool for key, value in allowed.items() if key != 'displayname'):
        raise APIError(400, 'Choose valid profile or administrator fields. Use explicit account actions for deactivation and password recovery.')
    if 'displayname' in allowed: allowed['displayname'] = text_value(allowed['displayname'], 200)
    if 'password' in data or 'deactivated' in data:
        raise APIError(400, 'Use the explicit account action for password recovery or deactivation.')
    sensitive = 'admin' in allowed or 'locked' in allowed
    async with service.admin_lock:
        session = await active_admin(request)
        protect(service, session, target, sensitive)
        if sensitive and data.get('confirmation') != target:
            raise APIError(400, 'Type the full Matrix user ID to confirm access changes.')
        async with service.user_locks.setdefault(target, asyncio.Lock()):
            session = await active_admin(request)
            # GET prevents the native PUT create-user behavior from turning a
            # profile edit into an undocumented account-provisioning path.
            await service.matrix('GET', '/_synapse/admin/v2/users/' + quote(target, safe=''), token=service.store.open(session['token']))
            result = await service.matrix('PUT', '/_synapse/admin/v2/users/' + quote(target, safe=''), allowed, service.store.open(session['token']))
            if 'admin' in allowed:
                service.store.db.execute('UPDATE accounts SET known_admin=? WHERE user_id=?', (int(allowed['admin']), target))
            if 'locked' in allowed:
                service.store.db.execute('INSERT OR IGNORE INTO accounts(user_id,created) VALUES(?,?)', (target, time.time()))
                service.store.db.execute('UPDATE accounts SET access_blocked=? WHERE user_id=?', ('locked' if allowed['locked'] else '', target))
                if allowed['locked']: await revoke_devices(service, target, service.store.open(session['token']))
            service.audit(session['user_id'], 'security_admin_access_updated' if sensitive else 'user_updated', target, ', '.join(allowed))
            return web.json_response(native_user(result))


def register_routes(app):
    service = app['service']; service.admin_lock = asyncio.Lock()
    columns = {row[1] for row in service.store.db.execute('PRAGMA table_info(accounts)')}
    for name, definition in (('password_change_required', 'INTEGER NOT NULL DEFAULT 0'), ('access_blocked', "TEXT NOT NULL DEFAULT ''"), ('credential_epoch', 'REAL NOT NULL DEFAULT 0'), ('upload_quota_bytes', 'INTEGER')):
        if name not in columns: service.store.db.execute('ALTER TABLE accounts ADD COLUMN ' + name + ' ' + definition)
    app.add_routes([web.get('/api/admin/users/{user_id}', detail), web.post('/api/admin/users/{user_id}/actions', actions)])
