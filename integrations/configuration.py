"""Read one immutable, validated hook configuration snapshot."""
import hashlib
import json
from pathlib import Path
import re


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
    keys = {}
    for name, hook in value['hooks'].items():
        if not re.fullmatch(r'[a-z0-9_-]{1,64}', name) or not isinstance(hook, dict):
            raise ValueError('Invalid hook')
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
