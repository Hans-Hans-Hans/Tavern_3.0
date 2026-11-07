"""Account-wide opt-in recovery of client-encrypted history keys.

Legacy email packages require a device-bound code and an account password.
Passphrase packages are decrypted entirely on the client. Opt-in authenticator
and email factors use server-held wrapping secrets, sealed with the account
store key and released only after session-bound, one-time verification.
"""
import re
import secrets
import time
from aiohttp import web
try:
    from .server import APIError, body_json
except ImportError:
    from server import APIError, body_json

ALGORITHM = 'm.megolm_backup.v1.curve25519-aes-sha2'
FIELDS = {'version', 'backupVersion', 'publicKey', 'salt', 'iv', 'ciphertext'}

def envelope(value):
    valid = isinstance(value, dict) and set(value) == FIELDS and type(value['version']) is int and value['version'] == 1
    if valid:
        for field, pattern in [('backupVersion', r'[^\s\x00-\x1f\x7f]{1,255}'), ('publicKey', r'[A-Za-z0-9+/]{43}=?'),
                               ('salt', r'[A-Za-z0-9+/]{22}=='), ('iv', r'[A-Za-z0-9+/]{16}'), ('ciphertext', r'[A-Za-z0-9+/]{64}')]:
            valid = valid and isinstance(value.get(field), str) and re.fullmatch(pattern, value[field]) is not None
    if not valid:
        raise APIError(400, 'The encrypted recovery package is invalid.', 'INVALID_RECOVERY_PACKAGE')
    return dict(value)

class HistoryRecovery:
    def __init__(self, service):
        self.service, self.store = service, service.store
        self.store.db.execute("""CREATE TABLE IF NOT EXISTS history_recovery(
            user_id TEXT PRIMARY KEY REFERENCES accounts(user_id) ON DELETE CASCADE,
            revision TEXT NOT NULL, package TEXT NOT NULL, credential_epoch REAL NOT NULL, updated REAL NOT NULL)""")
        self.store.db.execute("""CREATE TABLE IF NOT EXISTS history_passphrase(
            user_id TEXT PRIMARY KEY REFERENCES accounts(user_id) ON DELETE CASCADE,
            revision TEXT NOT NULL, package TEXT NOT NULL, updated REAL NOT NULL)""")
        self.store.db.execute("""CREATE TABLE IF NOT EXISTS history_factors(
            user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
            method TEXT NOT NULL, revision TEXT NOT NULL, package TEXT NOT NULL,
            PRIMARY KEY(user_id, method))""")

    def preferences(self, user):
        value = self.store.get('history-preferences:' + user,
                               {'mode': 'email' if self.row(user) else 'off', 'setupRequired': False})
        return {**value, 'methods': value.get('methods', [value['mode']] if value['mode'] != 'off' else [])}

    def enabled(self, user, method):
        return method in self.preferences(user)['methods']

    def enable(self, user, method):
        methods = self.preferences(user)['methods']
        if method not in methods:
            methods = [*methods, method]
        self.store.set('history-preferences:' + user,
                       {'mode': methods[0], 'methods': methods, 'setupRequired': False})

    def phrase_row(self, user):
        row = self.store.db.execute('SELECT * FROM history_passphrase WHERE user_id=?', (user,)).fetchone()
        return dict(row) if row else None

    async def options(self, request):
        session = self.service.require_session(request)
        data = await body_json(request, 1024)
        mode = data.get('mode')
        methods = data.get('methods', [] if mode == 'off' else [mode])
        if not isinstance(methods, list) or len(methods) > 3 or any(method not in ('passphrase', 'email', 'totp') for method in methods):
            raise APIError(400, 'Choose passphrase, email, authenticator, or no history recovery.')
        methods = list(dict.fromkeys(methods))
        if 'email' in methods and not self.service.smtp()['enabled'] and (mode == 'email' or not self.enabled(session['user_id'], 'email')):
            raise APIError(409, 'Email delivery is disabled. Choose passphrase recovery instead.', 'EMAIL_DISABLED')
        mode = methods[0] if methods else 'off'
        configured = self.phrase_row(session['user_id']) if mode == 'passphrase' else self.factor_row(session['user_id'], mode)
        if mode == 'email':
            configured = configured or self.row(session['user_id'])
        self.store.set('history-preferences:' + session['user_id'],
                       {'mode': mode, 'methods': methods, 'setupRequired': bool(methods) and not bool(configured)})
        self.store.db.execute("DELETE FROM challenges WHERE user_id=? AND kind IN ('history-recovery','history-factor')", (session['user_id'],))
        self.service.audit(session['user_id'], 'history_recovery_preference', session['user_id'], mode)
        return await self.status(request)

    async def passphrase(self, request):
        session = self.service.require_session(request)
        user = session['user_id']
        row = self.phrase_row(user)
        if request.method == 'GET':
            if not self.enabled(user, 'passphrase') or not row:
                raise APIError(409, 'Passphrase recovery is not enabled.', 'RECOVERY_NOT_CONFIGURED')
            self.store.rate('history-passphrase:' + user, 20, 300)
            value = envelope(self.store.open(row['package']))
            await self.native(session, value)
            self.service.require_session(request)
            if not self.enabled(user, 'passphrase') or self.phrase_row(user)['revision'] != row['revision']:
                raise APIError(409, 'Recovery settings changed. Start again.', 'RECOVERY_CHANGED')
            return web.json_response({'package': value})
        data = await body_json(request, 4096)
        self.store.rate('history-passphrase-save:' + user, 8, 300)
        value = envelope(data.get('package'))
        if data.get('revision') != (row['revision'] if row else None):
            raise APIError(409, 'Recovery settings changed. Reload before saving.', 'RECOVERY_CHANGED')
        await self.native(session, value)
        self.service.require_session(request)
        latest = self.phrase_row(user)
        if (latest['revision'] if latest else None) != (row['revision'] if row else None):
            raise APIError(409, 'Recovery settings changed. Reload before saving.', 'RECOVERY_CHANGED')
        revision = secrets.token_urlsafe(24)
        self.store.db.execute('''INSERT INTO history_passphrase VALUES(?,?,?,?) ON CONFLICT(user_id)
            DO UPDATE SET revision=excluded.revision,package=excluded.package,updated=excluded.updated''',
            (user, revision, self.store.seal(value), time.time()))
        self.enable(user, 'passphrase')
        self.store.db.execute("DELETE FROM challenges WHERE user_id=? AND kind='history-recovery'", (user,))
        self.service.audit(user, 'history_passphrase_enabled', user)
        return web.json_response({'revision': revision})

    def owner(self, request):
        session = self.service.require_session(request)
        account = self.store.account(session['user_id'])
        if not account.get('verified') or not account.get('email'):
            raise APIError(409, 'Verify your account email before enabling email history recovery.', 'EMAIL_NOT_VERIFIED')
        return session, account

    def row(self, user):
        value = self.store.db.execute('SELECT * FROM history_recovery WHERE user_id=?', (user,)).fetchone()
        return dict(value) if value else None

    async def native(self, session, value):
        backup = await self.service.matrix('GET', '/_matrix/client/v3/room_keys/version', token=self.store.open(session['token']))
        if backup.get('version') != value['backupVersion'] or backup.get('algorithm') != ALGORITHM or backup.get('auth_data', {}).get('public_key') != value['publicKey']:
            raise APIError(409, 'The native history backup changed. Use a device that can read the current backup.', 'BACKUP_CHANGED')

    def unchanged(self, request, account, revision):
        session, latest = self.owner(request)
        row = self.row(session['user_id'])
        if latest.get('email') != account.get('email') or latest.get('credential_epoch', 0) != account.get('credential_epoch', 0) or (row['revision'] if row else None) != revision:
            raise APIError(409, 'Recovery or account settings changed. Start again.', 'RECOVERY_CHANGED')

    async def password(self, request):
        session, account = self.owner(request)
        data = await body_json(request, 8192)
        await self.service.password_auth(session, data.get('password'))
        self.unchanged(request, account, (self.row(session['user_id']) or {}).get('revision'))
        return web.json_response({'credentialEpoch': account.get('credential_epoch', 0)})

    async def status(self, request):
        session = self.service.require_session(request)
        account, row = self.store.account(session['user_id']), self.row(session['user_id'])
        phrase = self.phrase_row(session['user_id'])
        preferences = self.preferences(session['user_id'])
        preferences = {**preferences, 'setupRequired': bool(preferences.get('setupRequired') and
            session['created'] >= preferences.get('promptAfter', 0))}
        return web.json_response({**preferences,
            'authenticatorReady': bool(account.get('totp')),
            'factorConfigured': {method: self.factor_matches(session['user_id'], method, account) for method in ('totp', 'email')},
            'factorRevisions': {method: (self.factor_row(session['user_id'], method) or {}).get('revision') for method in ('totp', 'email')},
            'passphraseConfigured': bool(phrase), 'passphraseRevision': phrase['revision'] if phrase else None,
            'configured': bool(row), 'revision': row['revision'] if row else None,
            'emailReady': bool(account.get('verified') and account.get('email') and self.service.smtp()['enabled']),
            'credentialEpoch': account.get('credential_epoch', 0),
            'passwordChanged': bool(row and row['credential_epoch'] != account.get('credential_epoch', 0)),
            'backupVersion': self.store.open(row['package'])['backupVersion'] if row else None})

    async def save(self, request):
        session, account = self.owner(request)
        if not self.service.smtp()['enabled']:
            raise APIError(409, 'Email delivery is disabled. Choose passphrase recovery instead.', 'EMAIL_DISABLED')
        data = await body_json(request, 4096)
        value = envelope(data.get('package'))
        self.store.rate('history-save:' + session['user_id'], 8, 300)
        row = self.row(session['user_id'])
        if data.get('revision') != (row['revision'] if row else None) or data.get('credentialEpoch') != account.get('credential_epoch', 0):
            raise APIError(409, 'Recovery or account credentials changed. Reload before enabling recovery.', 'RECOVERY_CHANGED')
        await self.native(session, value)
        # Account mutations share the /api/account/ middleware's per-user lock.
        self.unchanged(request, account, row['revision'] if row else None)
        revision = secrets.token_urlsafe(24)
        self.store.db.execute("""INSERT INTO history_recovery VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
            revision=excluded.revision,package=excluded.package,credential_epoch=excluded.credential_epoch,updated=excluded.updated""",
            (session['user_id'], revision, self.store.seal(value), account.get('credential_epoch', 0), time.time()))
        self.store.db.execute("DELETE FROM challenges WHERE user_id=? AND kind='history-recovery'", (session['user_id'],))
        self.service.audit(session['user_id'], 'email_history_enabled', session['user_id'])
        self.enable(session['user_id'], 'email')
        return web.json_response({'revision': revision})

    async def start(self, request):
        session, account = self.owner(request)
        if not self.enabled(session['user_id'], 'email') or not self.service.smtp()['enabled']:
            raise APIError(409, 'Email history recovery is disabled.', 'EMAIL_DISABLED')
        row = self.row(session['user_id'])
        if not row:
            raise APIError(409, 'Enable email history recovery on a device with your history keys first.', 'RECOVERY_NOT_CONFIGURED')
        self.store.rate('history-email:' + session['user_id'], 3, 300)
        await self.native(session, self.store.open(row['package']))
        self.unchanged(request, account, row['revision'])
        code = str(secrets.randbelow(1000000)).zfill(6)
        payload = {'session': session['id'], 'device': session['device_id'], 'email': account['email'],
                   'revision': row['revision'], 'epoch': account.get('credential_epoch', 0)}
        identity = self.store.challenge('history-recovery', payload, session['user_id'], code)
        try:
            await self.service.send_email(account['email'], 'Unlock your message history',
                f'Your history recovery code is {code}. It expires in 10 minutes. Enter it only on the Tavern device where you requested it.')
        except Exception:
            self.store.consume(identity)
            raise
        self.unchanged(request, account, row['revision'])
        return web.json_response({'challengeId': identity})

    async def complete(self, request):
        session, account = self.owner(request)
        if not self.enabled(session['user_id'], 'email') or not self.service.smtp()['enabled']:
            raise APIError(409, 'Email history recovery is disabled.', 'EMAIL_DISABLED')
        data = await body_json(request, 2048)
        challenge = self.store.read_challenge(data.get('challengeId', ''), 'history-recovery', session['user_id'])
        payload, row = challenge['payload'], self.row(session['user_id'])
        if not row or payload != {'session': session['id'], 'device': session['device_id'], 'email': account['email'],
                'revision': row['revision'], 'epoch': account.get('credential_epoch', 0)}:
            raise APIError(409, 'This recovery request no longer matches your device or account. Start again.', 'RECOVERY_CHANGED')
        self.store.verify_code(challenge, data.get('code'))
        value = envelope(self.store.open(row['package']))
        await self.native(session, value)
        self.unchanged(request, account, row['revision'])
        self.store.consume(challenge['id'])
        self.service.audit(session['user_id'], 'email_history_released', session['user_id'])
        return web.json_response({'package': value})

    def factor_row(self, user, method):
        row = self.store.db.execute('SELECT * FROM history_factors WHERE user_id=? AND method=?', (user, method)).fetchone()
        return dict(row) if row else None

    def factor_binding(self, account, method):
        if method == 'totp' and account.get('totp'):
            return self.store.digest('history-totp:' + self.store.open(account['totp']))
        if method == 'email' and account.get('verified') and account.get('email'):
            return self.store.digest('history-email:' + account['email'])
        raise APIError(409, 'Set up this verification method in Account security first.', 'FACTOR_NOT_CONFIGURED')

    def factor_matches(self, user, method, account):
        row = self.factor_row(user, method)
        if not row:
            return False
        try:
            return self.store.open(row['package'])['binding'] == self.factor_binding(account, method)
        except APIError:
            return False

    def factor_context(self, request, method, purpose):
        session = self.service.require_session(request)
        user = session['user_id']
        if method not in ('totp', 'email') or purpose not in ('save', 'recover'):
            raise APIError(400, 'Choose an authenticator or email recovery method.')
        account = self.store.account(user)
        binding = self.factor_binding(account, method)
        if method == 'email' and not self.service.smtp()['enabled']:
            raise APIError(409, 'Email delivery is disabled. Use another enabled method.', 'EMAIL_DISABLED')
        row = self.factor_row(user, method)
        if purpose == 'recover' and (not self.enabled(user, method) or not self.factor_matches(user, method, account)):
            raise APIError(409, 'Enable this history recovery method on a device with your history keys first.', 'RECOVERY_NOT_CONFIGURED')
        return session, row, {'session': session['id'], 'device': session['device_id'], 'method': method,
            'purpose': purpose, 'binding': binding, 'epoch': account.get('credential_epoch', 0),
            'revision': row['revision'] if row else None}

    async def factor_start(self, request):
        data = await body_json(request, 1024)
        session, row, payload = self.factor_context(request, data.get('method'), data.get('purpose'))
        self.store.rate('history-factor-start:' + session['user_id'], 8, 300)
        code = str(secrets.randbelow(1000000)).zfill(6) if payload['method'] == 'email' else None
        if code:
            self.store.rate('history-factor-email:' + session['user_id'], 3, 300)
        identity = self.store.challenge('history-factor', payload, session['user_id'], code)
        if code:
            try:
                await self.service.send_email(self.store.account(session['user_id'])['email'], 'Verify message history recovery',
                    f'Your history recovery code is {code}. It expires in 10 minutes. Enter it only on the Tavern device where you requested it.')
            except Exception:
                self.store.consume(identity)
                raise
        # Recheck identity, credentials and settings after asynchronous email delivery.
        self.factor_check(request, identity, payload['method'], payload['purpose'])
        return web.json_response({'challengeId': identity})

    def factor_check(self, request, identity, method, purpose):
        session, row, payload = self.factor_context(request, method, purpose)
        if not isinstance(identity, str) or not 1 <= len(identity) <= 128:
            raise APIError(400, 'Start history verification again.', 'CHALLENGE_EXPIRED')
        challenge = self.store.read_challenge(identity, 'history-factor', session['user_id'])
        if challenge['payload'] != payload:
            raise APIError(409, 'Recovery or account settings changed. Start again.', 'RECOVERY_CHANGED')
        return session, row, challenge

    def factor_verify(self, session, challenge, code):
        self.store.rate('history-factor-verify:' + session['user_id'], 10, 300)
        if challenge['payload']['method'] == 'email':
            self.store.verify_code(challenge, code)
        else:
            # Uses the same anti-replay counter as sign-in; a code cannot be reused
            # to unlock history after it has already authorized another action.
            self.store.db.execute('UPDATE challenges SET attempts=attempts+1 WHERE id=?', (challenge['id'],))
            self.service.verify_factor(session['user_id'], code, 'totp')

    def factor_recheck(self, request, challenge):
        payload = challenge['payload']
        _, _, latest = self.factor_context(request, payload['method'], payload['purpose'])
        pending = self.store.db.execute('SELECT 1 FROM challenges WHERE id=? AND expires>?', (challenge['id'], time.time())).fetchone()
        if latest != payload or not pending:
            raise APIError(409, 'Recovery or account settings changed. Start again.', 'RECOVERY_CHANGED')

    async def factor_save(self, request):
        data = await body_json(request, 4096)
        method, identity = data.get('method'), data.get('challengeId', '')
        session, row, challenge = self.factor_check(request, identity, method, 'save')
        self.store.rate('history-factor-save:' + session['user_id'], 8, 300)
        value, secret = envelope(data.get('package')), data.get('wrappingSecret')
        if not isinstance(secret, str) or not re.fullmatch(r'[A-Za-z0-9+/]{43}=', secret):
            raise APIError(400, 'Invalid history recovery wrapping secret.')
        if data.get('revision') != (row['revision'] if row else None):
            raise APIError(409, 'Recovery settings changed. Reload before saving.', 'RECOVERY_CHANGED')
        await self.service.password_auth(session, data.get('password'))
        self.factor_check(request, identity, method, 'save')
        self.factor_verify(session, challenge, data.get('code'))
        await self.native(session, value)
        self.factor_recheck(request, challenge)
        revision = secrets.token_urlsafe(24)
        sealed = self.store.seal({'package': value, 'wrappingSecret': secret, 'binding': challenge['payload']['binding']})
        self.store.db.execute('''INSERT INTO history_factors VALUES(?,?,?,?) ON CONFLICT(user_id,method)
            DO UPDATE SET revision=excluded.revision,package=excluded.package''', (session['user_id'], method, revision, sealed))
        self.enable(session['user_id'], method)
        self.store.consume(identity)
        self.service.audit(session['user_id'], 'history_factor_enabled', session['user_id'], method)
        return web.json_response({'revision': revision})

    async def factor_complete(self, request):
        data = await body_json(request, 2048)
        method, identity = data.get('method'), data.get('challengeId', '')
        session, row, challenge = self.factor_check(request, identity, method, 'recover')
        self.factor_verify(session, challenge, data.get('code'))
        value = self.store.open(row['package'])
        await self.native(session, value['package'])
        self.factor_recheck(request, challenge)
        self.store.consume(identity)
        self.service.audit(session['user_id'], 'history_factor_released', session['user_id'], method)
        return web.json_response({'package': value['package'], 'wrappingSecret': value['wrappingSecret']})

def register_routes(app):
    recovery = HistoryRecovery(app['service'])
    app.router.add_get('/api/account/history', recovery.status)
    app.router.add_post('/api/account/history/options', recovery.options)
    app.router.add_get('/api/account/history/passphrase', recovery.passphrase)
    app.router.add_post('/api/account/history/passphrase', recovery.passphrase)
    app.router.add_post('/api/account/history', recovery.save)
    app.router.add_post('/api/account/history/password', recovery.password)
    app.router.add_post('/api/account/history/start', recovery.start)
    app.router.add_post('/api/account/history/complete', recovery.complete)
    app.router.add_post('/api/account/history/factor/start', recovery.factor_start)
    app.router.add_post('/api/account/history/factor/save', recovery.factor_save)
    app.router.add_post('/api/account/history/factor/complete', recovery.factor_complete)
