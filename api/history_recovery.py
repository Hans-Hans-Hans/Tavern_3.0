"""Account-wide opt-in recovery of client-encrypted history keys.

Email packages require a device-bound code. Passphrase packages are released
only to their signed-in owner and decrypted entirely on the client.
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

    def preferences(self, user):
        return self.store.get('history-preferences:' + user,
                              {'mode': 'email' if self.row(user) else 'off', 'setupRequired': False})

    def phrase_row(self, user):
        row = self.store.db.execute('SELECT * FROM history_passphrase WHERE user_id=?', (user,)).fetchone()
        return dict(row) if row else None

    async def options(self, request):
        session = self.service.require_session(request)
        data = await body_json(request, 1024)
        mode = data.get('mode')
        if mode not in ('off', 'passphrase', 'email'):
            raise APIError(400, 'Choose off, passphrase, or email history recovery.')
        if mode == 'email' and not self.service.smtp()['enabled']:
            raise APIError(409, 'Email delivery is disabled. Choose passphrase recovery instead.', 'EMAIL_DISABLED')
        configured = self.phrase_row(session['user_id']) if mode == 'passphrase' else self.row(session['user_id'])
        self.store.set('history-preferences:' + session['user_id'],
                       {'mode': mode, 'setupRequired': mode != 'off' and not bool(configured)})
        self.store.db.execute("DELETE FROM challenges WHERE user_id=? AND kind='history-recovery'", (session['user_id'],))
        self.service.audit(session['user_id'], 'history_recovery_preference', session['user_id'], mode)
        return await self.status(request)

    async def passphrase(self, request):
        session = self.service.require_session(request)
        user = session['user_id']
        row = self.phrase_row(user)
        if request.method == 'GET':
            if self.preferences(user)['mode'] != 'passphrase' or not row:
                raise APIError(409, 'Passphrase recovery is not enabled.', 'RECOVERY_NOT_CONFIGURED')
            self.store.rate('history-passphrase:' + user, 20, 300)
            value = envelope(self.store.open(row['package']))
            await self.native(session, value)
            self.service.require_session(request)
            if self.preferences(user)['mode'] != 'passphrase' or self.phrase_row(user)['revision'] != row['revision']:
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
        self.store.set('history-preferences:' + user, {'mode': 'passphrase', 'setupRequired': False})
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
        self.store.set('history-preferences:' + session['user_id'], {'mode': 'email', 'setupRequired': False})
        return web.json_response({'revision': revision})

    async def start(self, request):
        session, account = self.owner(request)
        if self.preferences(session['user_id'])['mode'] != 'email' or not self.service.smtp()['enabled']:
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
        if self.preferences(session['user_id'])['mode'] != 'email' or not self.service.smtp()['enabled']:
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
