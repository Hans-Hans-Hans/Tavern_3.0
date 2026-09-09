"""Measured system diagnostics and release tracking; no Docker socket in the API."""
import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import shutil
import time

import aiohttp
from aiohttp import web

REPOSITORY = 'Hans-Hans-Hans/Tavern_3.0'
RELEASE_API = f'https://api.github.com/repos/{REPOSITORY}/releases?per_page=30'


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def version_info():
    return {'version': os.environ.get('TAVERN_VERSION', '0.4.0'),
            'commit': os.environ.get('TAVERN_COMMIT') or None,
            'buildDate': os.environ.get('TAVERN_BUILD_DATE') or None,
            'channel': os.environ.get('TAVERN_CHANNEL', 'development'),
            'imageTag': os.environ.get('TAVERN_IMAGE_TAG') or None}


def release_version(tag):
    match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?', tag)
    return tuple(map(int, match.groups()[:3])) if match else None


def release_summary(releases):
    def item(release):
        tag = release.get('tag_name', '')
        version = release_version(tag)
        if not version or release.get('draft'):
            return None
        return {'version': tag.removeprefix('v'), 'tag': tag,
                'url': f'https://github.com/{REPOSITORY}/releases/tag/{tag}',
                'publishedAt': release.get('published_at'),
                'notes': str(release.get('body') or '')[:20000]}
    stable = [item(row) for row in releases if not row.get('prerelease') and '-' not in row.get('tag_name', '')]
    prerelease = [item(row) for row in releases if row.get('prerelease') or '-' in row.get('tag_name', '')]
    newest = lambda rows: max((row for row in rows if row), key=lambda row: release_version(row['tag']), default=None)
    current = version_info()
    latest_stable, latest_prerelease = newest(stable), newest(prerelease)
    return {'current': current, 'latestStable': latest_stable, 'latestPrerelease': latest_prerelease,
            'updateAvailable': bool(latest_stable and release_version(latest_stable['tag']) > (release_version(current['version']) or (0, 0, 0))),
            'checkedAt': now_iso(), 'repository': REPOSITORY}


async def version(request):
    return web.json_response(version_info())


async def live(request):
    return web.json_response({'status': 'ok'})


async def measure(service):
    checks = []
    start = time.perf_counter()
    try:
        result = service.store.db.execute('PRAGMA quick_check(1)').fetchone()[0]
        checks.append({'component': 'Account database', 'status': 'healthy' if result == 'ok' else 'error',
                       'detail': 'SQLite integrity check passed.' if result == 'ok' else 'Database integrity check failed; restore a verified backup.',
                       'latencyMs': round((time.perf_counter() - start) * 1000, 2)})
    except Exception:
        checks.append({'component': 'Account database', 'status': 'error', 'detail': 'Account database cannot be read.'})
    start = time.perf_counter()
    try:
        async with service.http.get(service.config.synapse_url + '/health', timeout=aiohttp.ClientTimeout(total=5), allow_redirects=False) as response:
            healthy = response.status == 200
        checks.append({'component': 'Messaging homeserver', 'status': 'healthy' if healthy else 'error',
                       'detail': 'Synapse answered its health endpoint.' if healthy else 'Synapse is not ready; inspect its container logs.',
                       'latencyMs': round((time.perf_counter() - start) * 1000, 2)})
    except (aiohttp.ClientError, asyncio.TimeoutError):
        checks.append({'component': 'Messaging homeserver', 'status': 'error', 'detail': 'Cannot reach Synapse. Check the internal service and network.'})
    usage = shutil.disk_usage(service.config.data_dir)
    checks.append({'component': 'Storage', 'status': 'healthy' if usage.free >= 512 * 1024 * 1024 else 'warning',
                   'detail': f'{usage.free // (1024 * 1024)} MiB available on account storage.', 'freeBytes': usage.free, 'totalBytes': usage.total})
    smtp = service.smtp(reveal=False)
    checks.append({'component': 'Email', 'status': 'configured' if smtp.get('enabled') else 'disabled',
                   'detail': 'Use Email → Test Connection to verify delivery settings.' if smtp.get('enabled') else 'Configure SMTP to enable verification, recovery, and email MFA.'})
    calls = os.environ.get('CALLS_ENABLED', 'false').lower() == 'true'
    if calls:
        try:
            async with service.http.get('http://livekit:7880/', timeout=aiohttp.ClientTimeout(total=5), allow_redirects=False) as response:
                healthy = response.status == 200
            checks.append({'component': 'Voice signaling', 'status': 'healthy' if healthy else 'error', 'detail': 'LiveKit health probe completed. External media requires a two-network call test.'})
        except (aiohttp.ClientError, asyncio.TimeoutError):
            checks.append({'component': 'Voice signaling', 'status': 'error', 'detail': 'LiveKit is not reachable on the internal network.'})
        checks.append({'component': 'TURN', 'status': 'not_tested', 'detail': 'Validate a call from outside the LAN; a local HTTP check cannot prove public UDP routing.'})
    else:
        checks.append({'component': 'Voice signaling', 'status': 'disabled', 'detail': 'Enable the calls profile after configuring TURN DNS and public media ports.'})
    return checks


async def ready(request):
    service = request.app['service']
    checks = await measure(service)
    healthy = not any(row['status'] == 'error' for row in checks[:2])
    return web.json_response({'status': 'ready' if healthy else 'unavailable'}, status=200 if healthy else 503)


async def diagnostics(request):
    service = request.app['service']
    session = await service.require_admin(request)
    service.store.rate('diagnostics:' + session['user_id'], 10, 60)
    return web.json_response({'checks': await measure(service), 'checkedAt': now_iso(), 'version': version_info()})


async def updates(request):
    service = request.app['service']
    session = await service.require_admin(request)
    cached = service.store.get('release_status')
    last_check = service.store.get('release_check_time', 0)
    refresh = request.method == 'POST'
    if cached and not refresh and time.time() - last_check < 3600:
        return web.json_response({**cached, 'automaticUpdates': await automatic_status(service)})
    service.store.rate('release-check:' + session['user_id'], 6, 3600)
    try:
        async with service.http.get(RELEASE_API, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'Tavern/' + version_info()['version']},
                                    timeout=aiohttp.ClientTimeout(total=10), allow_redirects=False, auto_decompress=True) as response:
            if response.status != 200:
                raise ValueError('The release service did not return release metadata.')
            content = await response.content.read(1024 * 1024 + 1)
            if len(content) > 1024 * 1024:
                raise ValueError('Release response was too large.')
            import json
            releases = json.loads(content)
            if not isinstance(releases, list):
                raise ValueError('Invalid release metadata.')
        result = release_summary(releases)
        service.store.set('release_status', result)
        service.store.set('release_check_time', time.time())
        service.audit(session['user_id'], 'updates.checked')
    except (ValueError, aiohttp.ClientError, asyncio.TimeoutError):
        return web.json_response({'error': 'Could not check GitHub releases. Try again later.', 'cached': cached, 'current': version_info()}, status=503)
    return web.json_response({**result, 'automaticUpdates': await automatic_status(service)})


async def backups(request):
    service = request.app['service']
    if not operations_enabled():
        await service.require_admin(request)
        return web.json_response({'available': False, 'backups': [],
                                  'reason': 'Enable the operations profile and OPERATIONS_ENABLED to manage full server backups here.',
                                  'manualCommand': 'python3 scripts/operations.py backup --output /your/private/backup-directory'})
    return await proxy_operation(request, '/state' if request.method == 'GET' else '/backups')


def operations_enabled():
    return os.environ.get('OPERATIONS_ENABLED', 'false').lower() == 'true'


def operations_auth():
    if not operations_enabled():
        raise ValueError('Enable the operations profile before managing backups or container updates.')
    token = Path(os.environ.get('OPERATIONS_TOKEN_FILE', '/run/tavern-operations/token')).read_text().strip()
    if len(token) < 40:
        raise ValueError('The operations credential is missing. Run the initializer.')
    return {'Authorization': 'Bearer ' + token}


async def automatic_status(service):
    if not operations_enabled():
        return {'available': False, 'enabled': False, 'reason': 'Enable the isolated operations profile to configure automatic updates.'}
    try:
        async with service.http.get(os.environ.get('OPERATIONS_URL', 'http://operations:8091') + '/settings', headers=operations_auth(),
                                    timeout=aiohttp.ClientTimeout(total=5), allow_redirects=False) as response:
            settings = await response.json()
            if response.status != 200:
                raise ValueError('Operations settings unavailable.')
        return {'available': True, 'enabled': settings['autoUpdateEnabled'], 'channel': settings['channel'], 'updateTime': settings['updateTime']}
    except (OSError, ValueError, aiohttp.ClientError, asyncio.TimeoutError):
        return {'available': False, 'enabled': False, 'reason': 'The operations worker is not reachable. Check its health and private token mount.'}


async def proxy_operation(request, path):
    service = request.app['service']
    session = await service.require_admin(request)
    if not operations_enabled():
        return web.json_response({'error': 'Enable the isolated operations profile first.'}, status=503)
    data = None
    if request.method in ('POST', 'PUT'):
        if request.can_read_body:
            data = await request.json()
        else:
            data = {}
        service.store.rate('operations:' + session['user_id'], 20, 3600)
    try:
        async with service.http.request(request.method, os.environ.get('OPERATIONS_URL', 'http://operations:8091') + path,
                                       headers=operations_auth(), json=data, timeout=aiohttp.ClientTimeout(total=3600 if path.endswith('/download') else 30),
                                       allow_redirects=False) as response:
            if path.endswith('/download') and response.status == 200:
                result = web.StreamResponse(status=200, headers={'Content-Type': 'application/x-tar', 'Content-Disposition': response.headers.get('Content-Disposition', 'attachment'), 'Cache-Control': 'no-store'})
                if response.headers.get('Content-Length'):
                    result.headers['Content-Length'] = response.headers['Content-Length']
                service.audit(session['user_id'], 'backup.downloaded', request.match_info['identity'])
                await result.prepare(request)
                async for chunk in response.content.iter_chunked(65536):
                    await result.write(chunk)
                await result.write_eof()
                return result
            body = await response.json()
            if request.method not in ('GET', 'HEAD') and response.status < 300:
                service.audit(session['user_id'], 'operations.' + request.method.lower(), path)
            return web.json_response(body, status=response.status)
    except (OSError, ValueError, aiohttp.ClientError, asyncio.TimeoutError):
        return web.json_response({'error': 'The operations worker is not reachable. Check its container and private token mount.'}, status=503)


async def operation_settings(request):
    return await proxy_operation(request, '/settings')


async def backup_item(request):
    identity = request.match_info['identity']
    if not re.fullmatch(r'tavern-[a-f0-9]{32}', identity):
        return web.json_response({'error': 'Invalid backup identifier.'}, status=400)
    suffix = '/download' if request.path.endswith('/download') else '/restore' if request.path.endswith('/restore') else ''
    return await proxy_operation(request, '/backups/' + identity + suffix)


async def apply_update(request):
    return await proxy_operation(request, '/updates/apply')


async def operation_job(request):
    identity = request.match_info['identity']
    if not re.fullmatch(r'[a-f0-9]{32}', identity):
        return web.json_response({'error': 'Invalid operation identifier.'}, status=400)
    return await proxy_operation(request, '/jobs/' + identity)


def register_routes(app):
    app.add_routes([web.get('/api/system/version', version), web.get('/health/live', live), web.get('/health/ready', ready),
                    web.get('/api/admin/diagnostics', diagnostics), web.get('/api/admin/updates', updates),
                    web.post('/api/admin/updates/check', updates), web.get('/api/admin/backups', backups), web.post('/api/admin/backups', backups),
                    web.get('/api/admin/operations/settings', operation_settings), web.put('/api/admin/operations/settings', operation_settings),
                    web.get('/api/admin/backups/{identity}/download', backup_item), web.delete('/api/admin/backups/{identity}', backup_item),
                    web.post('/api/admin/backups/{identity}/restore', backup_item), web.post('/api/admin/updates/apply', apply_update),
                    web.get('/api/admin/operations/jobs/{identity}', operation_job)])
