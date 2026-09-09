"""Validated public branding and administrator-controlled authentication policy."""
import asyncio
import hashlib
from io import BytesIO
import json
import os
import re
import secrets
import time
from urllib.parse import urlsplit

from aiohttp import web
from PIL import Image, ImageOps, UnidentifiedImageError

try:
    from .server import APIError, body_json, text_value
    from .security import DEFAULT_SECURITY
except ImportError:
    from server import APIError, body_json, text_value
    from security import DEFAULT_SECURITY

ASSET_LIMIT = 2 * 1024 * 1024
ASSET_SLOTS = ('icon', 'logo', 'background')


def revision(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def branding(service):
    current = service.store.get('instance', {'name': 'Tavern', 'description': ''})
    used = {current.get(slot) for slot in ASSET_SLOTS}
    unused = ['/api/branding/assets/' + path.name for path in sorted((service.config.data_dir / 'branding').glob('*.png'))
              if re.fullmatch(r'[a-f0-9]{64}\.png', path.name) and '/api/branding/assets/' + path.name not in used]
    return {**current, 'revision': revision(current), 'unusedAssets': unused}


def normalize_branding(value, directory):
    if not isinstance(value, dict): raise APIError(400, 'Enter valid instance branding.')
    result = {field: text_value(value.get(field, ''), maximum).strip() for field, maximum in (('name', 80), ('description', 500), ('contact', 254), ('termsUrl', 2048), ('privacyUrl', 2048))}
    if not result['name']: raise APIError(400, 'Give this instance a name.')
    for field in ('termsUrl', 'privacyUrl'):
        url = urlsplit(result[field])
        if result[field] and (url.scheme != 'https' or not url.hostname or url.username or url.password):
            raise APIError(400, 'Use a public HTTPS URL for terms and privacy links.')
    for slot in ASSET_SLOTS:
        asset = text_value(value.get(slot, ''), 160)
        match = re.fullmatch(r'/api/branding/assets/([a-f0-9]{64})\.png', asset)
        if asset and (not match or not (directory / (match[1] + '.png')).is_file()):
            raise APIError(400, 'Choose an image uploaded through instance branding.')
        result[slot] = asset
    return result


def image_bytes(raw, slot):
    try:
        with Image.open(BytesIO(raw), formats=('PNG', 'JPEG', 'WEBP')) as source:
            if source.width > 4096 or source.height > 4096 or source.width * source.height > 8_000_000 or getattr(source, 'n_frames', 1) != 1:
                raise APIError(400, 'Use a still image no larger than 4096 pixels per side and 8 million pixels.')
            source.load()
            # Copy only decoded pixels into a new object, excluding EXIF, ICC,
            # comments and original format payloads from the public asset.
            pixels = ImageOps.exif_transpose(source).convert('RGBA')
            pixels.thumbnail((1920, 1080) if slot == 'background' else (512, 512), Image.Resampling.LANCZOS)
            clean = Image.new('RGBA', pixels.size); clean.paste(pixels)
            output = BytesIO(); clean.save(output, format='PNG', optimize=True)
            result = output.getvalue()
            if len(result) > ASSET_LIMIT: raise APIError(400, 'This image is too complex. Choose a smaller image.')
            return result
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise APIError(400, 'Choose a valid still PNG, JPEG, or WebP image.') from None


async def branding_settings(request):
    service = request.app['service']; session = await service.require_admin(request)
    if request.method == 'PUT':
        value = await body_json(request)
        current = service.store.get('instance', {'name': 'Tavern', 'description': ''})
        if value.get('revision') != revision(current): raise APIError(409, 'Branding changed. Reload it before saving.', 'CONFIG_CHANGED')
        service.store.set('instance', normalize_branding(value, service.config.data_dir / 'branding'))
        service.audit(session['user_id'], 'instance_branding_updated', 'instance')
    return web.json_response(branding(service))


async def upload_asset(request):
    service = request.app['service']; session = await service.require_admin(request)
    slot = request.match_info['slot']
    if slot not in ASSET_SLOTS: raise APIError(400, 'Choose an icon, logo, or login background.')
    service.store.rate('branding-upload:' + session['user_id'], 12, 3600)
    if request.content_length and request.content_length > ASSET_LIMIT: raise APIError(413, 'Use an image smaller than 2 MiB.')
    raw = bytearray()
    async with request.app['branding_slot']:
        async with asyncio.timeout(30):
            async for chunk in request.content.iter_chunked(16384):
                raw.extend(chunk)
                if len(raw) > ASSET_LIMIT: raise APIError(413, 'Use an image smaller than 2 MiB.')
        encoded = await asyncio.to_thread(image_bytes, raw, slot)
        name = hashlib.sha256(encoded).hexdigest() + '.png'
        directory = service.config.data_dir / 'branding'; directory.mkdir(exist_ok=True)
        # An explicit cap also bounds unpublished drafts from repeated uploads.
        if not (directory / name).exists() and len(list(directory.glob('*.png'))) >= 100:
            raise APIError(413, 'The branding image archive is full. Remove unused branding assets before uploading more.')
        if not (directory / name).exists():
            temporary = directory / ('.upload-' + secrets.token_hex(12))
            try:
                temporary.write_bytes(encoded); temporary.chmod(0o600); os.replace(temporary, directory / name)
            finally:
                temporary.unlink(missing_ok=True)
        service.audit(session['user_id'], 'instance_branding_image_uploaded', 'instance', slot)
        return web.json_response({'url': '/api/branding/assets/' + name})


async def asset(request):
    name = request.match_info['name']
    if not re.fullmatch(r'[a-f0-9]{64}\.png', name): raise web.HTTPNotFound()
    path = request.app['service'].config.data_dir / 'branding' / name
    if not path.is_file(): raise web.HTTPNotFound()
    return web.FileResponse(path, headers={'Content-Type': 'image/png', 'Content-Security-Policy': "default-src 'none'; sandbox"})


async def cleanup_assets(request):
    service = request.app['service']; session = await service.require_admin(request)
    data = await body_json(request); assets = data.get('assets')
    if data.get('confirmation') != 'DELETE UNUSED' or not isinstance(assets, list) or not 1 <= len(assets) <= 100:
        raise APIError(400, 'Choose unused images and type DELETE UNUSED to confirm.')
    if any(not isinstance(value, str) or not re.fullmatch(r'/api/branding/assets/[a-f0-9]{64}\.png', value) for value in assets):
        raise APIError(400, 'Choose images from the branding archive.')
    async with request.app['branding_slot']:
        current = service.store.get('instance', {})
        if any(current.get(slot) in assets for slot in ASSET_SLOTS):
            raise APIError(409, 'An image is now published. Reload branding before removing unused images.', 'CONFIG_CHANGED')
        directory = service.config.data_dir / 'branding'
        for value in set(assets): (directory / value.rsplit('/', 1)[1]).unlink(missing_ok=True)
        service.audit(session['user_id'], 'instance_branding_images_removed', 'instance', str(len(set(assets))))
    return web.json_response(branding(service))


def normalize_security(value):
    if not isinstance(value, dict): raise APIError(400, 'Enter valid security settings.')
    result = {}
    ranges = {'minimumPasswordLength': (12, 128), 'sessionHours': (1, 72), 'persistentDays': (1, 90), 'loginPerIpPerMinute': (5, 100), 'loginPerAccountPerFiveMinutes': (3, 30)}
    for field, (low, high) in ranges.items():
        number = value.get(field, DEFAULT_SECURITY[field])
        if type(number) is not int or not low <= number <= high: raise APIError(400, f'{field} must be between {low} and {high}.')
        result[field] = number
    if value.get('mfaRequirement', 'off') not in ('off', 'admins', 'everyone'): raise APIError(400, 'Choose who must enroll in two-step verification.')
    if value.get('registrationMode', 'admin') not in ('admin', 'invite', 'open', 'disabled'): raise APIError(400, 'Choose a valid registration mode.')
    result['mfaRequirement'] = value.get('mfaRequirement', 'off')
    result['registrationMode'] = value.get('registrationMode', 'admin')
    return result


def security_view(service):
    value = {**service.security_policy(), 'registrationMode': service.store.get('policy', {}).get('registrationMode', 'admin')}
    return {**value, 'revision': revision(value), 'emailVerificationRequired': True,
            'deployment': {'allowedOrigin': service.config.public_url, 'trustedProxyCidrs': service.config.trusted_proxies, 'uploadValidation': 'Encrypted media is opaque. File bytes and storage quotas are enforced; branding images are decoded and re-encoded.'}}


async def security_settings(request):
    service = request.app['service']; session = await service.require_admin(request)
    if request.method == 'PUT':
        data = await body_json(request)
        async with service.admin_lock:
            async with service.user_locks.setdefault(session['user_id'], asyncio.Lock()):
                session = await service.require_admin(request)
                await service.require_sensitive(request, data)
                value = normalize_security(data.get('settings'))
                if data.get('revision') != security_view(service)['revision']: raise APIError(409, 'Security policy changed. Reload before saving.', 'CONFIG_CHANGED')
                mode = value.pop('registrationMode')
                service.store.db.execute('BEGIN IMMEDIATE')
                try:
                    service.store.set('security_policy', value)
                    service.store.set('policy', {**service.store.get('policy', {}), 'registrationMode': mode})
                    service.audit(session['user_id'], 'security_policy_updated', 'instance')
                    service.store.db.execute('COMMIT')
                except Exception:
                    service.store.db.execute('ROLLBACK')
                    raise
    return web.json_response(security_view(service))


def register_routes(app):
    app['branding_slot'] = asyncio.Semaphore(1)
    service = app['service']
    if 'known_admin' not in {row[1] for row in service.store.db.execute('PRAGMA table_info(accounts)')}:
        service.store.db.execute('ALTER TABLE accounts ADD COLUMN known_admin INTEGER NOT NULL DEFAULT 0')
    app.add_routes([web.get('/api/admin/branding', branding_settings), web.put('/api/admin/branding', branding_settings),
                    web.post('/api/admin/branding/assets/{slot}', upload_asset), web.get('/api/branding/assets/{name}', asset),
                    web.post('/api/admin/branding/cleanup', cleanup_assets),
                    web.get('/api/admin/security-policy', security_settings), web.put('/api/admin/security-policy', security_settings)])
