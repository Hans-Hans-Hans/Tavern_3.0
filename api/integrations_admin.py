"""Manage signed hook configuration without returning the bot's Matrix credentials."""
import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import time
from functools import wraps
from urllib.parse import quote

import aiohttp
from aiohttp import web

try:
    from .server import APIError, body_json, text_value
    from .room_authority import room_authority, room_id, content
except ImportError:
    from server import APIError, body_json, text_value
    from room_authority import room_authority, room_id, content


def delegated(request):
    return not request.path.startswith('/api/admin/')


def serialized_change(handler):
    @wraps(handler)
    async def wrapped(request):
        service = request.app['service']; session = service.require_session(request)
        service.store.rate('webhooks-write:' + session['user_id'], 30, 60)
        async with service.user_locks.setdefault(session['user_id'], asyncio.Lock()):
            service.require_session(request)
            return await handler(request)
    return wrapped


async def authorize(request, room=None):
    service = request.app['service']
    if not delegated(request):
        session = await service.require_admin(request)
        service.require_session(request)
        return session, None
    session = service.require_session(request)
    authority = await room_authority(service, session, room_id(room))
    if not authority.policies or content(authority.state, 'm.room.create').get('type') == 'm.space':
        raise APIError(403, 'Manage webhooks in an encrypted channel of a managed server.')
    authority.require('manage_webhooks', native='state_default')
    now = int(time.time() * 1000)
    if authority.model.temporary_ban_active(authority.state, session['user_id'], now) or any(authority.model.temporary_ban_active(parent, session['user_id'], now) for _, _, parent in authority.policies):
        raise APIError(403, 'A temporary ban prevents webhook management in this channel.')
    service.require_session(request)
    return session, authority


def hook_metadata(data, identity, current=None):
    current = current or {}
    name = text_value(data.get('name', current.get('name', identity)), 80).strip()
    avatar = text_value(data.get('avatarUrl', current.get('avatar_url', '')), 2048)
    enabled = data.get('enabled', current.get('enabled', True))
    if not name or re.search(r'[\x00-\x1f\x7f]', name):
        raise APIError(400, 'Choose a webhook name of up to 80 characters without control characters.')
    if avatar and not re.fullmatch(r'mxc://[^/\s?#]+/[A-Za-z0-9_-]+', avatar):
        raise APIError(400, 'Choose an avatar uploaded to Matrix.')
    if type(enabled) is not bool:
        raise APIError(400, 'Choose whether this webhook is enabled.')
    return {'name': name, 'avatar_url': avatar, 'enabled': enabled}


def approved_users(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 200:
        raise APIError(400, 'List each approved room member, including the dedicated bot.')
    return sorted(set(matrix_user(user) for user in value))


async def check_destination(service, session, room, users, authority=None):
    if authority is not None:
        events = [{'type': kind, 'state_key': key, 'content': event.content} for (kind, key), event in authority.state.items()]
    else:
        state = await service.matrix('GET', '/_synapse/admin/v1/rooms/' + quote(room, safe='') + '/state', token=service.store.open(session['token']))
        events = state.get('state', [])
    if not isinstance(events, list) or len(events) > 50000:
        raise APIError(503, 'The destination membership could not be safely checked.')
    members = {event['state_key'] for event in events if event.get('type') == 'm.room.member' and event.get('content', {}).get('membership') == 'join'}
    if not any(event.get('type') == 'm.room.encryption' and event.get('content', {}).get('algorithm') == 'm.megolm.v1.aes-sha2' for event in events):
        raise APIError(400, 'The webhook destination must be an encrypted room.')
    if not members.issubset(users):
        raise APIError(400, 'Every currently joined room member must be explicitly approved.')


def hook_view(service, identity, value):
    return {'id': identity, 'name': value.get('name', identity), 'avatarUrl': value.get('avatar_url', ''),
        'enabled': value.get('enabled', True), 'createdBy': value.get('created_by'), 'createdAt': value.get('created_at'),
        'roomId': value.get('room_id', ''), 'allowedUsers': value.get('allowed_users', []),
        'url': service.config.public_url + '/hooks/' + identity}


def matrix_user(value):
    if not isinstance(value, str) or not re.fullmatch(r"@[^\s:]{1,200}:[^\s/]{1,200}", value):
        raise APIError(400, "Enter a full Matrix user ID.")
    return value


class IntegrationConfig:
    def __init__(self, service):
        self.service = service
        self.enabled = os.environ.get("INTEGRATIONS_ENABLED", "false").casefold() == "true"
        self.directory = Path(os.environ.get("INTEGRATIONS_CONFIG_DIR", "/integrations-config"))
        self.lock = asyncio.Lock()

    def read(self):
        if not self.enabled or not self.directory.is_dir() or self.directory.is_symlink():
            raise APIError(503, "Enable the integrations profile and its configuration mount before managing webhooks.", "INTEGRATIONS_DISABLED")
        path = self.directory / "bot.json"
        if path.is_symlink():
            raise APIError(503, "The bot configuration must be a regular file.")
        if not path.exists():
            return {"homeserver": self.service.config.synapse_url, "hooks": {}, "trusted_devices": {}, "retired_hooks": []}, ""
        if path.stat().st_size > 512000:
            raise APIError(503, "The bot configuration is too large.")
        try:
            raw = path.read_bytes()
            value = json.loads(raw)
        except (ValueError, OSError):
            raise APIError(503, "The bot configuration could not be read.") from None
        if not isinstance(value, dict) or not isinstance(value.get("hooks"), dict) or not isinstance(value.get("trusted_devices", {}), dict):
            raise APIError(503, "The bot configuration has an invalid structure.")
        return value, hashlib.sha256(raw).hexdigest()

    def check_revision(self, data, revision):
        if data.get("revision") != revision:
            raise APIError(409, "The integration configuration changed. Reload it before saving.", "CONFIG_CHANGED")

    def write(self, value):
        encoded = (json.dumps(value, indent=2) + "\n").encode()
        if len(encoded) > 512000:
            raise APIError(413, 'The integration configuration is full. Ask an administrator to review retired hooks and device approvals.')
        path = self.directory / (".bot-" + secrets.token_hex(12) + ".tmp")
        try:
            with path.open("xb") as stream:
                path.chmod(0o600)
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(path, self.directory / "bot.json")
        finally:
            path.unlink(missing_ok=True)
        return hashlib.sha256(encoded).hexdigest()

    def new_secret(self, hook):
        value = secrets.token_urlsafe(48)
        name = "managed-" + hook + "-" + secrets.token_hex(12) + ".hmac"
        path = self.directory / name
        with path.open("x", encoding="ascii") as stream:
            path.chmod(0o600)
            stream.write(value + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        return value, "/config/" + name

    def remove_managed_secret(self, configured):
        if isinstance(configured, str) and re.fullmatch(r"/config/managed-[a-z0-9_-]+-[a-f0-9]{24}\.hmac", configured):
            path = self.directory / configured.removeprefix("/config/")
            if not path.is_symlink():
                path.unlink(missing_ok=True)


async def inventory(request):
    service = request.app["service"]
    session, _ = await authorize(request, request.query.get('roomId'))
    service.store.rate('webhooks-read:' + session['user_id'], 120, 60)
    manager = service.integrations
    if not manager.enabled:
        return web.json_response({"enabled": False, "configured": False, "ready": False, "hooks": [], "pins": [], "revision": ""})
    config, revision = manager.read()
    ready, active = False, ""
    try:
        async with service.http.get("http://integrations:8080/health", timeout=aiohttp.ClientTimeout(total=2), allow_redirects=False, auto_decompress=True) as response:
            health = await response.json()
            ready = response.status == 200 and health.get("ready") is True
            active = health.get("configuration", "")
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
        pass
    await authorize(request, request.query.get('roomId'))
    hooks = [hook_view(service, identity, value) for identity, value in config['hooks'].items() if not delegated(request) or value.get('room_id') == request.query.get('roomId')]
    pins = [] if delegated(request) else [{"userId": user, "deviceId": device, "fingerprint": fingerprint} for user, devices in config.get("trusted_devices", {}).items() for device, fingerprint in devices.items()]
    service.require_session(request)
    return web.json_response({"enabled": True, "configured": bool(revision), "ready": ready, "applied": bool(revision) and active == revision, "revision": revision, "hooks": hooks, "pins": pins, 'scope': request.query.get('roomId') if delegated(request) else 'instance'})


@serialized_change
async def create_hook(request):
    service = request.app["service"]
    data, manager = await body_json(request), service.integrations
    identity = text_value(data.get("id"), 64)
    room = room_id(data.get('roomId'))
    if not re.fullmatch(r"[a-z0-9_-]{1,64}", identity) or data.get("confirmation") != room:
        raise APIError(400, "Choose a hook ID and type the full destination room ID to confirm.")
    users = approved_users(data.get('allowedUsers')); metadata = hook_metadata(data, identity)
    async with manager.lock:
        session, authority = await authorize(request, room)
        config, revision = manager.read()
        manager.check_revision(data, revision)
        if identity in config["hooks"] or identity in config.get("retired_hooks", []):
            raise APIError(409, "That hook ID is already used or retired. Choose a new ID.")
        if len(config["hooks"]) >= 100:
            raise APIError(400, "This instance supports up to 100 active hooks.")
        await check_destination(service, session, room, users, authority)
        if not delegated(request): await service.require_admin(request)
        service.require_session(request)
        secret, path = manager.new_secret(identity)
        config["hooks"][identity] = {"room_id": room, "allowed_users": users, "secret_file": path, **metadata,
                                     'created_by': session['user_id'], 'created_at': int(time.time() * 1000)}
        try:
            revision = manager.write(config)
        except Exception:
            manager.remove_managed_secret(path)
            raise
    service.audit(session["user_id"], "webhook_created", identity, room)
    return web.json_response({"id": identity, "secret": secret, "url": service.config.public_url + "/hooks/" + identity, "revision": revision}, status=201)


@serialized_change
async def change_hook(request):
    service = request.app["service"]
    data, identity, manager = await body_json(request), request.match_info["identity"], service.integrations
    if not re.fullmatch(r'[a-z0-9_-]{1,64}', identity) or data.get("confirmation") != identity:
        raise APIError(400, "Type the hook ID to confirm this change.")
    async with manager.lock:
        session, authority = await authorize(request, data.get('roomId'))
        config, revision = manager.read()
        manager.check_revision(data, revision)
        hook = config["hooks"].get(identity)
        if not hook or delegated(request) and hook.get('room_id') != data.get('roomId'):
            raise APIError(404, "This webhook no longer exists.")
        if 'roomId' in data and data['roomId'] != hook['room_id']:
            raise APIError(400, 'Create a new webhook and signing secret to use another destination. Existing queued deliveries remain bound to their original room.')
        old, secret = hook.get("secret_file"), None
        if request.method == "DELETE":
            del config["hooks"][identity]
            config.setdefault("retired_hooks", []).append(identity)
        elif request.method == 'PUT':
            metadata = hook_metadata(data, identity, hook)
            users = approved_users(data.get('allowedUsers', hook['allowed_users']))
            if metadata['enabled'] or users != sorted(hook['allowed_users']):
                await check_destination(service, session, hook['room_id'], users, authority)
            hook.update(metadata, allowed_users=users)
        else:
            secret, path = manager.new_secret(identity)
            hook["secret_file"] = path
        try:
            if request.method == 'PUT' and not delegated(request): await service.require_admin(request)
            service.require_session(request)
            revision = manager.write(config)
        except Exception:
            if secret:
                manager.remove_managed_secret(path)
            raise
        if request.method != 'PUT': manager.remove_managed_secret(old)
    service.audit(session["user_id"], "webhook_revoked" if request.method == "DELETE" else "webhook_updated" if request.method == 'PUT' else "webhook_secret_rotated", identity, hook.get('room_id', ''))
    return web.json_response({"ok": True, "revision": revision, **({"secret": secret} if secret else {})})


@serialized_change
async def change_pin(request):
    service = request.app["service"]
    session = await service.require_admin(request)
    data, manager = await body_json(request), service.integrations
    user, device = matrix_user(data.get("userId")), text_value(data.get("deviceId"), 255)
    if not device or data.get("confirmation") != "VERIFIED":
        raise APIError(400, "Verify the device fingerprint independently, then type VERIFIED to confirm.")
    fingerprint = ""
    if request.method == "POST":
        fingerprint = "".join(text_value(data.get("fingerprint"), 100).split()).rstrip("=")
        if not re.fullmatch(r"[A-Za-z0-9+/]{43}", fingerprint):
            raise APIError(400, "Enter the device's full Ed25519 fingerprint.")
        value = await service.matrix("POST", "/_matrix/client/v3/keys/query", {"device_keys": {user: [device]}}, service.store.open(session["token"]))
        actual = value.get("device_keys", {}).get(user, {}).get(device, {}).get("keys", {}).get("ed25519:" + device, "")
        if not isinstance(actual, str) or not hmac.compare_digest(fingerprint, actual.rstrip("=")):
            raise APIError(400, "That fingerprint does not match the current homeserver device key.")
    async with manager.lock:
        await service.require_admin(request)
        config, revision = manager.read()
        manager.check_revision(data, revision)
        pins = config.setdefault("trusted_devices", {})
        if request.method == "POST":
            if sum(map(len, pins.values())) >= 1000 and device not in pins.get(user, {}):
                raise APIError(400, "This instance supports up to 1000 approved devices.")
            pins.setdefault(user, {})[device] = fingerprint
        else:
            pins.get(user, {}).pop(device, None)
            if user in pins and not pins[user]:
                del pins[user]
        service.require_session(request)
        revision = manager.write(config)
    service.audit(session["user_id"], "webhook_device_approved" if request.method == "POST" else "webhook_device_revoked", user, device)
    return web.json_response({"ok": True, "revision": revision})


def register_routes(app):
    app["service"].integrations = IntegrationConfig(app["service"])
    app.add_routes([web.get("/api/admin/integrations", inventory), web.post("/api/admin/integrations/hooks", create_hook),
                    web.put('/api/admin/integrations/hooks/{identity}', change_hook),
                    web.post("/api/admin/integrations/hooks/{identity}/rotate", change_hook), web.delete("/api/admin/integrations/hooks/{identity}", change_hook),
                    web.get('/api/integrations', inventory), web.post('/api/integrations/hooks', create_hook),
                    web.put('/api/integrations/hooks/{identity}', change_hook), web.post('/api/integrations/hooks/{identity}/rotate', change_hook), web.delete('/api/integrations/hooks/{identity}', change_hook),
                    web.post("/api/admin/integrations/pins", change_pin), web.delete("/api/admin/integrations/pins", change_pin)])
