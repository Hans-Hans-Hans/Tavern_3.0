"""Durable self-deactivation; native account state decides local cleanup.

The journal contains identifiers and progress only, never authentication factors,
tokens, message bodies or email addresses. Reconciliation is read-only upstream:
an ambiguous request never becomes an unattended privileged deactivation.
"""
import asyncio
import logging
import secrets
import time
from urllib.parse import quote

import aiohttp
from aiohttp import web

try:
    from .server import APIError, body_json
except ImportError:
    from server import APIError, body_json

LOG = logging.getLogger('tavern.api.deactivation')
PENDING = ('pending', 'native_confirmed')


class Deactivations:
    def __init__(self, service, app):
        self.service, self.app = service, app
        service.store.db.executescript('''
            CREATE TABLE IF NOT EXISTS account_deactivations(
                id TEXT PRIMARY KEY,user_id TEXT NOT NULL,erase INTEGER NOT NULL,
                phase TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,next_check REAL NOT NULL DEFAULT 0,
                issue TEXT NOT NULL DEFAULT '');
            CREATE UNIQUE INDEX IF NOT EXISTS active_deactivation_user
                ON account_deactivations(user_id) WHERE phase IN ('pending','native_confirmed');
            CREATE INDEX IF NOT EXISTS deactivation_reconciliation
                ON account_deactivations(phase,next_check);
        ''')

    def pending(self, user):
        return self.service.store.db.execute(
            "SELECT * FROM account_deactivations WHERE user_id=? AND phase IN ('pending','native_confirmed')", (user,)).fetchone()

    def view(self, user):
        row = self.service.store.db.execute('SELECT * FROM account_deactivations WHERE user_id=? ORDER BY created DESC,id DESC LIMIT 1', (user,)).fetchone()
        if not row:
            return None
        return {'id': row['id'], 'phase': row['phase'], 'profileErasureRequested': bool(row['erase']),
                'createdAt': int(row['created'] * 1000), 'updatedAt': int(row['updated'] * 1000), 'issue': row['issue']}

    def deny_pending(self, user):
        row = self.pending(user)
        if row:
            raise APIError(403, 'Account deactivation is awaiting confirmation. Contact an administrator with reference ' + row['id'] + '.',
                           'ACCOUNT_DEACTIVATION_PENDING')

    def unavailable(self, user):
        row = self.view(user)
        return bool(row and row['phase'] in (*PENDING, 'complete'))

    def begin(self, user, erase):
        db = self.service.store.db
        identity, now = secrets.token_urlsafe(18), time.time()
        db.execute('BEGIN IMMEDIATE')
        try:
            db.execute("INSERT INTO account_deactivations(id,user_id,erase,phase,created,updated) VALUES(?,?,?,'pending',?,?)", (identity, user, int(erase), now, now))
            db.execute("UPDATE accounts SET access_blocked='deactivation_pending',credential_epoch=? WHERE user_id=?", (now, user))
            # The already-authorized request holds its native token in memory.
            # Other browser sessions and unfinished logins must not survive it.
            db.execute('DELETE FROM sessions WHERE user_id=?', (user,))
            db.execute('DELETE FROM challenges WHERE user_id=?', (user,))
            self.service.audit(user, 'account_deactivation_requested', user, identity)
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
        return identity

    def mark_confirmed(self, identity):
        self.service.store.db.execute("UPDATE account_deactivations SET phase='native_confirmed',updated=?,issue='' WHERE id=? AND phase='pending'", (time.time(), identity))

    def cleanup(self, identity):
        """Atomic personal-state removal; retain others' blocks and shared evidence.

        Uploaded files are retained in this release. Their usage and unresolved
        reservations must remain charged; deleting them would overbook storage.
        Redemption capacity is never refunded when its personal record is removed.
        """
        service, db = self.service, self.service.store.db
        row = db.execute('SELECT * FROM account_deactivations WHERE id=?', (identity,)).fetchone()
        if not row or row['phase'] != 'native_confirmed':
            return
        user = row['user_id']
        account = service.store.account(user)
        peers = {r[0] for r in db.execute('SELECT target FROM social_requests WHERE sender=? UNION SELECT sender FROM social_requests WHERE target=?', (user, user))}
        db.execute('BEGIN IMMEDIATE')
        try:
            for table in ('sessions', 'challenges', 'recovery_codes', 'social_preferences', 'social_friend_codes'):
                db.execute('DELETE FROM ' + table + ' WHERE user_id=?', (user,))
            db.execute('DELETE FROM social_requests WHERE sender=? OR target=?', (user, user))
            db.execute('DELETE FROM social_blocks WHERE blocker=?', (user,))
            db.execute('DELETE FROM invitation_redemptions WHERE user_id=?', (user,))
            db.execute("UPDATE invitations SET revoked=1,email=NULL,domain=NULL,splash_mxc='',default_roles='[]' WHERE creator=?", (user,))
            if account.get('verified') and account.get('email'):
                db.execute("UPDATE invitations SET revoked=1,email=NULL WHERE lower(email)=lower(?)", (account['email'],))
            db.execute("DELETE FROM upload_reservations WHERE user_id=? AND state='stored'", (user,))
            db.execute('DELETE FROM accounts WHERE user_id=?', (user,))
            db.execute("UPDATE account_deactivations SET phase='complete',updated=?,issue='',next_check=0 WHERE id=?", (time.time(), identity))
            service.audit(user, 'account_deactivated', user, identity)
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
        getattr(service, 'profile_metadata_cache', {}).pop(user, None)
        if account.get('verified') and account.get('email') and service.smtp()['enabled']:
            recipient = account['email']
            async def notice():
                try:
                    await service.send_email(recipient, 'Account deactivated', 'Your Tavern account has been deactivated. Historical messages and uploaded files have not been deleted.')
                except Exception:
                    service.audit(user, 'security_email_failed', user)
            service.background(notice())
        for peer in peers | {user}:
            for queue in self.app.get('social_watchers', {}).get(peer, set()):
                if not queue.full():
                    queue.put_nowait(True)

    async def reconcile(self, identity, token=None):
        """Caller holds the account lock. Never infer success from an invalid token."""
        service, db = self.service, self.service.store.db
        row = db.execute('SELECT * FROM account_deactivations WHERE id=?', (identity,)).fetchone()
        if not row or row['phase'] not in PENDING:
            return
        issue = 'homeserver_unavailable'
        try:
            async with asyncio.timeout(10):
                status, native = await service.matrix('GET', '/_synapse/admin/v2/users/' + quote(row['user_id'], safe=''),
                                                      token=token or await service.service_token(), expected=False)
            if status == 200 and isinstance(native, dict) and native.get('name') == row['user_id'] and type(native.get('deactivated')) is bool:
                if native['deactivated']:
                    self.mark_confirmed(identity)
                    self.cleanup(identity)
                    return
                issue = 'native_account_active'
                db.execute("UPDATE account_deactivations SET phase='pending' WHERE id=?", (identity,))
        except (APIError, aiohttp.ClientError, asyncio.TimeoutError):
            pass
        except Exception:
            # Local cleanup failures roll back and remain recoverable. Log no
            # upstream body, account credentials, email, or exception message.
            issue = 'local_cleanup_pending'
            LOG.error('Deactivation cleanup needs another attempt')
        attempts = row['attempts'] + 1
        db.execute('UPDATE account_deactivations SET attempts=?,updated=?,next_check=?,issue=? WHERE id=? AND phase IN (?,?)',
                   (attempts, time.time(), time.time() + min(3600, 30 * 2 ** min(attempts, 7)), issue, identity, *PENDING))

    async def sweep(self):
        service = self.service
        rows = service.store.db.execute("SELECT id,user_id FROM account_deactivations WHERE phase IN ('pending','native_confirmed') AND next_check<=? ORDER BY next_check,id LIMIT 10", (time.time(),)).fetchall()
        for row in rows:
            lock = service.user_locks.setdefault(row['user_id'], asyncio.Lock())
            if lock.locked():
                continue
            async with lock:
                await self.reconcile(row['id'])

    async def run(self):
        while True:
            try:
                await self.sweep()
            except Exception:
                LOG.error('Deactivation reconciliation will retry')
            await asyncio.sleep(30)


async def deactivate(request):
    service = request.app['service']; data = await body_json(request)
    session = service.require_session(request)
    if set(data) - {'password', 'code', 'method', 'challengeId', 'confirmation', 'erase'} or ('erase' in data and type(data['erase']) is not bool):
        raise APIError(400, 'Choose valid account deactivation options.')
    if data.get('confirmation') != session['user_id']:
        raise APIError(400, 'Type your full Matrix user ID to confirm account deletion.')
    async with asyncio.timeout(12):
        session = await service.require_sensitive(request, data)
        status, admin = await service.matrix('GET', '/_synapse/admin/v1/users/' + quote(session['user_id'], safe='') + '/admin', token=service.store.open(session['token']), expected=False)
    if status not in (200, 403) or status == 200 and (not isinstance(admin, dict) or type(admin.get('admin')) is not bool):
        raise APIError(503, 'Administrator status could not be checked. Account deactivation remains locked.')
    if status == 200 and admin['admin'] or session['user_id'] == service.store.get('service_account', {}).get('userId'):
        raise APIError(400, 'An administrator account must be deactivated by another active administrator.')
    service.require_session(request)
    manager = service.deactivations
    identity = manager.begin(session['user_id'], data.get('erase') is True)
    request['clearCookie'] = True
    try:
        async with asyncio.timeout(15):
            await service.uia(session, '/_matrix/client/v3/account/deactivate', {'erase': data.get('erase') is True}, data['password'])
    except APIError as error:
        if error.code == 'UNSUPPORTED_UIA':
            # This is the initial, non-mutating UIA challenge, not a timeout.
            db = service.store.db
            db.execute("UPDATE account_deactivations SET phase='rejected',issue='unsupported_authentication',updated=? WHERE id=?", (time.time(), identity))
            db.execute("UPDATE accounts SET access_blocked='' WHERE user_id=? AND access_blocked='deactivation_pending'", (session['user_id'],))
            raise APIError(error.status, error.message, error.code, signedOut=True) from None
        await manager.reconcile(identity)
    except Exception:
        # Invalid/truncated upstream responses are ambiguous too. Cancellation
        # deliberately propagates; the durable journal is recovered at startup.
        await manager.reconcile(identity)
    else:
        # A successful HTTP status is not proof that Synapse applied the change:
        # proxies can return HTML or malformed success bodies. Only the exact
        # native account's authoritative inactive state permits local cleanup.
        await manager.reconcile(identity)
    phase = manager.view(session['user_id'])['phase']
    complete = phase == 'complete'
    return web.json_response({'ok': complete, 'deactivation': {'id': identity, 'phase': phase},
        'message': 'Your account has been deactivated. Historical messages and uploaded files have not been deleted.' if complete else
        'Your homeserver account is deactivated. Tavern is finishing local personal-data cleanup. Contact an administrator with reference ' + identity + '.' if phase == 'native_confirmed' else
        'Your account deactivation is awaiting confirmation. Tavern access is locked while the server checks the result. Contact an administrator with reference ' + identity + '.'}, status=200 if complete else 202)


def register_routes(app):
    service = app['service']
    service.deactivations = Deactivations(service, app)
    async def start(_):
        service.background(service.deactivations.run())
    app.on_startup.append(start)
