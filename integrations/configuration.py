"""Read one immutable, validated hook configuration snapshot."""
import hashlib
import json
from pathlib import Path
import re


def persist_destinations(db, config):
    """Destination bindings survive config replacement and process restarts."""
    with db:
        for hook, value in config['hooks'].items():
            previous = db.execute('SELECT room FROM hook_destinations WHERE hook=?', (hook,)).fetchone()
            if previous and previous[0] != value['room_id']:
                raise RuntimeError('Existing webhook destinations are immutable')
            db.execute('INSERT OR IGNORE INTO hook_destinations VALUES(?,?)', (hook, value['room_id']))


def cancel_unconfigured(db, hooks):
    """Retain delivery tombstones while wiping removed/disabled hook payloads."""
    with db:
        pending = db.execute("SELECT DISTINCT hook FROM deliveries WHERE status='pending'").fetchall()
        for (hook,) in pending:
            if hook not in hooks or not hooks[hook].get('enabled', True):
                db.execute("UPDATE deliveries SET status='cancelled',payload=NULL,nonce=NULL,tag=NULL WHERE hook=? AND status='pending'", (hook,))


def validate_metadata(hook):
    """Optional fields preserve existing hand-written/signed hook configurations."""
    if 'name' in hook:
        name = hook['name']
        if not isinstance(name, str) or not 1 <= len(name) <= 80 or name != name.strip() or re.search(r'[\x00-\x1f\x7f]', name):
            raise ValueError('Invalid webhook display name')
    if 'avatar_url' in hook:
        avatar = hook['avatar_url']
        if not isinstance(avatar, str) or len(avatar) > 2048 or avatar and not re.fullmatch(r'mxc://[^/\s?#]+/[A-Za-z0-9_-]+', avatar):
            raise ValueError('Webhook avatars must be Matrix media URLs')
    if 'enabled' in hook and type(hook['enabled']) is not bool:
        raise ValueError('Webhook enabled must be a boolean')
    if 'created_by' in hook and (not isinstance(hook['created_by'], str) or len(hook['created_by']) > 255 or not re.fullmatch(r'@[^\s:]+:[^\s]+', hook['created_by'])):
        raise ValueError('Invalid webhook creator')
    if 'created_at' in hook and (type(hook['created_at']) is not int or not 0 <= hook['created_at'] <= 9007199254740991):
        raise ValueError('Invalid webhook creation time')


def message_content(identity, hook, text):
    """Labels stay inside encrypted content; the dedicated Matrix sender is unchanged."""
    return {'msgtype': 'm.notice', 'body': text, 'io.tavern.webhook': {
        'id': identity, 'name': hook.get('name', identity), 'avatar_url': hook.get('avatar_url', ''),
    }}


def load_configuration(path):
    path = Path(path)
    if path.is_symlink() or path.stat().st_size > 512000:
        raise ValueError('Invalid bot configuration file')
    raw = path.read_bytes()
    value = json.loads(raw)
    if not isinstance(value, dict) or not isinstance(value.get('homeserver'), str) or not isinstance(value.get('hooks'), dict) or not isinstance(value.get('trusted_devices', {}), dict):
        raise ValueError('Invalid bot configuration')
    if len(value['hooks']) > 100:
        raise ValueError('Too many hooks')
    if 'system_messages' in value:
        try:
            from system_messages import configured_key
        except ImportError:
            from integrations.system_messages import configured_key
        configured_key(value, path.parent)
    keys = {}
    for name, hook in value['hooks'].items():
        if not re.fullmatch(r'[a-z0-9_-]{1,64}', name) or not isinstance(hook, dict):
            raise ValueError('Invalid hook')
        validate_metadata(hook)
        if not isinstance(hook.get('room_id'), str) or not hook['room_id'].startswith('!') or ':' not in hook['room_id']:
            raise ValueError('Invalid destination')
        if not isinstance(hook.get('allowed_users'), list) or not 1 <= len(hook['allowed_users']) <= 200 or any(not isinstance(user, str) or not user.startswith('@') or ':' not in user for user in hook['allowed_users']):
            raise ValueError('Invalid approved membership')
        configured = hook.get('secret_file', '')
        if not isinstance(configured, str) or not re.fullmatch(r'/config/[a-zA-Z0-9_.-]+', configured):
            raise ValueError('Secrets must be direct files in the configured volume')
        secret_path = path.parent / configured.removeprefix('/config/')
        if secret_path.is_symlink() or secret_path.stat().st_size > 1024:
            raise ValueError('Invalid hook secret file')
        secret = secret_path.read_bytes().strip()
        if len(secret) < 32:
            raise ValueError('Hook secrets need at least 32 bytes')
        keys[name] = secret
    for user, devices in value.get('trusted_devices', {}).items():
        if not isinstance(user, str) or not isinstance(devices, dict):
            raise ValueError('Invalid trusted device map')
        if any(not isinstance(device, str) or not isinstance(fingerprint, str) or not re.fullmatch(r'[A-Za-z0-9+/]{43}=?', fingerprint) for device, fingerprint in devices.items()):
            raise ValueError('Invalid trusted fingerprint')
    return value, keys, hashlib.sha256(raw).hexdigest()
