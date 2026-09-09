"""Recipient-owned invitation policy and a scoped internal contact-consent check."""
import hashlib
import asyncio
import hmac
import os
from pathlib import Path
import re
import time
from collections.abc import Mapping
from urllib.parse import quote

from aiohttp import web

try:
    from .server import APIError, body_json
except ImportError:
    from server import APIError, body_json

POLICY = 'io.tavern.privacy'
MODES = ('everyone', 'contacts', 'shared_server', 'nobody')
SETTINGS_TIMEOUT = 15


def contact_signature(key, timestamp, sender, recipient):
    payload = '\n'.join(('v1', 'invitation-consent', timestamp, sender, recipient))
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


async def settings(request):
    service = request.app['service']
    session = service.require_session(request)
    try:
        # Includes lock acquisition, streamed body reads and the native write.
        async with asyncio.timeout(SETTINGS_TIMEOUT):
            async with service.user_locks.setdefault(session['user_id'], asyncio.Lock()):
                return await settings_locked(request)
    except asyncio.TimeoutError:
        raise APIError(504, 'Saving or loading invitation preferences timed out. Reload the current settings before retrying.') from None


async def settings_locked(request):
    service = request.app['service']
    session = service.require_session(request)
    path = '/_matrix/client/v3/user/' + quote(session['user_id'], safe='') + '/account_data/' + POLICY
    token = service.store.open(session['token'])
    status, current = await service.matrix('GET', path, token=token, expected=False)
    service.require_session(request)
    if status not in (200, 404) or status == 200 and not isinstance(current, Mapping):
        raise APIError(502, 'Your conversation invitation settings could not be read. Try again.')
    current = current if status == 200 and isinstance(current, Mapping) else {}
    if request.method == 'PUT':
        data = await body_json(request)
        service.require_session(request)
        if data.get('invitations') not in MODES:
            raise APIError(400, 'Choose who can invite you to conversations.')
        service.store.rate('invitation-privacy:' + session['user_id'], 10, 60)
        # Native account data has no CAS. The user lock serializes Tavern API
        # changes, while this read detects other-device changes during the body
        # wait. A native writer can still race the final GET-to-PUT interval.
        fresh_status, fresh = await service.matrix('GET', path, token=token, expected=False)
        service.require_session(request)
        fresh = {} if fresh_status == 404 else fresh
        if fresh_status not in (200, 404) or fresh != current:
            raise APIError(409, 'Your conversation preferences changed. Reload before saving.')
        current = {**current, 'version': 1, 'invitations': data['invitations']}
        await service.matrix('PUT', path, current, token)
        service.require_session(request)
        service.audit(session['user_id'], 'invitation_privacy_changed', session['user_id'], data['invitations'])
    mode = current.get('invitations', 'everyone')
    return web.json_response({'invitations': mode if mode in MODES else 'nobody'})


async def internal_consent(request):
    sender, recipient = request.query.get('sender', ''), request.query.get('recipient', '')
    timestamp, supplied = request.headers.get('X-Tavern-Privacy-Timestamp', ''), request.headers.get('X-Tavern-Privacy-Signature', '')
    valid = all(re.fullmatch(r'@[^\s:]{1,128}:[^\s]{1,255}', user) for user in (sender, recipient)) and re.fullmatch(r'[0-9]{1,12}', timestamp) and abs(time.time() - int(timestamp)) <= 30
    if valid:
        try:
            key = bytes.fromhex(Path(os.environ.get('PRIVACY_KEY_FILE', '/synapse/tavern-privacy.key')).read_text().strip())
            valid = len(key) == 32 and hmac.compare_digest(contact_signature(key, timestamp, sender, recipient), supplied)
        except (ValueError, OSError):
            valid = False
    if not valid:
        raise APIError(403, 'This internal request is not authorized.', 'FORBIDDEN')
    db = request.app['service'].store.db
    blocked = db.execute('SELECT 1 FROM social_blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)', (sender, recipient, recipient, sender)).fetchone()
    accepted = db.execute("SELECT 1 FROM social_requests WHERE status='accepted' AND ((sender=? AND target=?) OR (sender=? AND target=?))", (sender, recipient, recipient, sender)).fetchone()
    return web.json_response({'allowed': bool(accepted) and not bool(blocked)})


def register_routes(app):
    app.add_routes([web.get('/api/social/invitation-privacy', settings), web.put('/api/social/invitation-privacy', settings), web.get('/api/internal/invitation-consent', internal_consent)])
