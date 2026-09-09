"""Optional private Docker operator. No arbitrary commands, images, paths or projects."""
import asyncio
import copy
from datetime import datetime, timezone
import hashlib
import hmac
import io
import json
import logging
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sqlite3
import tarfile
import tempfile
import time
from urllib.request import Request, urlopen

from aiohttp import web
import docker

try:
    from archive_host import digest, verify_archive
except ImportError:
    from scripts.operations import digest, verify_archive

LOG = logging.getLogger('tavern.operations')
SERVICES = {'init', 'tavern-web', 'tavern-api', 'synapse', 'postgres', 'integrations', 'operations'}
UPDATE_IMAGES = {'tavern-web': 'ghcr.io/hans-hans-hans/tavern', 'tavern-api': 'ghcr.io/hans-hans-hans/tavern-api'}
REPOSITORY = 'Hans-Hans-Hans/Tavern_3.0'
DEFAULT_SETTINGS = {'backupEnabled': False, 'backupTime': '03:00', 'retention': 14,
                    'autoUpdateEnabled': False, 'updateTime': '04:00', 'channel': 'stable'}


def validate_settings(value):
    if not isinstance(value, dict) or set(value) - set(DEFAULT_SETTINGS):
        raise ValueError('Unknown operations setting.')
    result = {**DEFAULT_SETTINGS, **value}
    for key in ('backupEnabled', 'autoUpdateEnabled'):
        if not isinstance(result[key], bool):
            raise ValueError('Enable settings must be true or false.')
    for key in ('backupTime', 'updateTime'):
        if not isinstance(result[key], str) or not re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', result[key]):
            raise ValueError('Schedules use UTC time in HH:MM format.')
    if type(result['retention']) is not int or not 1 <= result['retention'] <= 365 or result['channel'] not in ('stable', 'prerelease'):
        raise ValueError('Retention must be 1–365 backups and channel stable or prerelease.')
    return result


def scoped_container(attributes, project):
    labels = attributes.get('Config', {}).get('Labels') or {}
    service = labels.get('com.docker.compose.service')
    return (not re.search(r'-rollback-[a-f0-9]{12}$', attributes.get('Name', '')) and labels.get('com.docker.compose.project') == project and labels.get('io.tavern.managed') == 'true'
            and service in SERVICES and not labels.get('io.tavern.rollback'))


def allowed_release(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', value):
        raise ValueError('Choose a published semantic release version.')
    return value


def version_order(value):
    value = allowed_release(value)
    core, _, suffix = value.partition('-')
    identifiers = tuple((0, int(part)) if part.isdigit() else (1, part) for part in suffix.split('.')) if suffix else ()
    return (*map(int, core.split('.')), not bool(suffix), identifiers)


def read_json(url):
    with urlopen(Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'Tavern-operations'}), timeout=20) as response:
        raw = response.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError('Release metadata is too large.')
    return json.loads(raw)


class Operator:
    def __init__(self, directory, project, engine=None):
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', project):
            raise ValueError('Invalid fixed Compose project.')
        self.root, self.project = Path(directory), project
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / 'backups').mkdir(exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(self.root / 'operations.sqlite3', isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);'
                             'CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,result TEXT NOT NULL);')
        self.db.execute("UPDATE jobs SET state='interrupted',result=? WHERE state IN ('running','queued')", (json.dumps({'error': 'Worker restarted during the operation. Review container state and backup archives before retrying.'}),))
        self.engine = engine if engine is not None else docker.from_env(version='auto', timeout=120)
        self.task = None
        self.lock = asyncio.Lock()

    def get(self, key, default=None):
        row = self.db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key, value):
        self.db.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, json.dumps(value)))

    def containers(self):
        result = {}
        for container in self.engine.containers.list(all=True, filters={'label': [f'com.docker.compose.project={self.project}', 'io.tavern.managed=true']}):
            container.reload()
            if not scoped_container(container.attrs, self.project):
                continue
            service = container.labels['com.docker.compose.service']
            if service in result:
                raise ValueError('More than one managed container exists for a service; resolve duplicate deployment state before operating.')
            result[service] = container
        return result

    def check(self, container):
        container.reload()
        if not scoped_container(container.attrs, self.project):
            raise ValueError('Container ownership changed. Operation was rejected.')

    def backup_list(self):
        return [{'id': path.stem, 'createdAt': datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(), 'sizeBytes': path.stat().st_size}
                for path in sorted((self.root / 'backups').glob('tavern-*.tar'), key=lambda item: item.stat().st_mtime, reverse=True) if re.fullmatch(r'tavern-[a-f0-9]{32}', path.stem) and not path.is_symlink()]

    def archive_path(self, identity):
        if not re.fullmatch(r'tavern-[a-f0-9]{32}', identity):
            raise ValueError('Invalid backup identifier.')
        path = self.root / 'backups' / (identity + '.tar')
        if not path.is_file() or path.is_symlink():
            raise ValueError('Backup does not exist.')
        return path

    def exec_to_file(self, container, command, target):
        self.check(container)
        self.stream_exec(container, command, target)

    def stream_exec(self, container, command, target):
        """Use the raw exec stream: Docker's JSON logs replace invalid UTF-8 bytes."""
        execution = self.engine.api.exec_create(container.id, command, stdout=True, stderr=True)
        for output, error in self.engine.api.exec_start(execution['Id'], stream=True, demux=True):
            if output:
                target.write(output)
        if self.engine.api.exec_inspect(execution['Id']).get('ExitCode') != 0:
            raise ValueError('File export failed; no complete backup was created.')

    def backup(self, identity):
        containers = self.containers()
        for required in ('init', 'postgres', 'synapse', 'tavern-api'):
            if required not in containers:
                raise ValueError('Required managed Tavern containers are missing. Deploy the canonical stack with operations labels first.')
        if containers['postgres'].status != 'running':
            raise ValueError('PostgreSQL must be running to create a backup.')
        if shutil.disk_usage(self.root).free < 512 * 1024 * 1024:
            raise ValueError('Operations storage needs at least 512 MiB free, plus enough space for database and media copies.')
        writers = [containers[key] for key in ('integrations', 'tavern-api', 'synapse') if key in containers and containers[key].status == 'running']
        paused, helper = [], None
        destination = self.root / 'backups' / ('tavern-' + identity + '.tar')
        partial = destination.with_suffix('.partial')
        with tempfile.TemporaryDirectory(prefix='backup-', dir=self.root) as scratch:
            scratch = Path(scratch)
            try:
                for container in writers:
                    self.check(container)
                    paused.append(container)
                    container.stop(timeout=30)
                with (scratch / 'synapse.dump').open('wb') as target:
                    self.exec_to_file(containers['postgres'], ['pg_dump', '-U', 'synapse', '-Fc', 'synapse'], target)
                initializer = containers['init']
                self.check(initializer)
                helper = self.engine.containers.create(initializer.attrs['Image'], command=['-c', 'import time; time.sleep(3600)'],
                    entrypoint=['python'], network_mode='none', volumes_from=[initializer.id + ':ro'], read_only=True,
                    cap_drop=['ALL'], cap_add=['DAC_READ_SEARCH'], security_opt=['no-new-privileges:true'], user='0:0',
                    labels={'io.tavern.managed': 'true', 'io.tavern.temporary': identity, 'com.docker.compose.project': self.project})
                helper.start()
                with (scratch / 'state.tar.gz').open('wb') as target:
                    # This exact helper was just created above from the trusted
                    # initializer image with only this stack's read-only volumes.
                    self.stream_exec(helper, ['python', '/app/state_archive.py', 'export'], target)
                with tarfile.open(scratch / 'state.tar.gz', 'r:gz') as state_archive:
                    for member in state_archive:
                        if not member.isfile() and not member.isdir():
                            raise ValueError('Persistent export contains unsupported file types.')
                manifest = {'format': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
                    'files': {name: digest(scratch / name) for name in ('synapse.dump', 'state.tar.gz')},
                    'images': {key: {'id': containers[key].attrs['Image'], 'reference': containers[key].attrs['Config']['Image']} for key in ('init', 'postgres', 'synapse', 'tavern-api', 'tavern-web') if key in containers}}
                (scratch / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
                with tarfile.open(partial, 'w') as archive:
                    os.chmod(partial, 0o600)
                    for name in ('manifest.json', 'synapse.dump', 'state.tar.gz'):
                        archive.add(scratch / name, arcname=name, recursive=False)
                partial.replace(destination)
            finally:
                try:
                    partial.unlink(missing_ok=True)
                except OSError:
                    LOG.warning('An incomplete backup file could not be removed.')
                if helper is not None:
                    try:
                        helper.remove(force=True, v=False)
                    except Exception:
                        LOG.warning('Temporary backup container cleanup failed; continuing service recovery.')
                errors = []
                for container in reversed(paused):
                    try:
                        self.check(container)
                        container.start()
                    except Exception:
                        errors.append(container.name)
                if errors:
                    raise ValueError('Backup ended, but some Tavern services could not restart. Inspect the Docker host before continuing.')
        return {'backupId': destination.stem, 'sizeBytes': destination.stat().st_size}

    def worker_mount(self):
        worker = self.containers().get('operations')
        if not worker:
            raise ValueError('Cannot identify the operations storage mount.')
        self.check(worker)
        for mount in worker.attrs['Mounts']:
            if mount['Destination'] == '/data' and mount['Type'] in ('bind', 'volume'):
                return mount
        raise ValueError('Operations storage mount is unavailable.')

    def restore_copy(self, identity, backup_id):
        backup = self.archive_path(backup_id)
        target_project = self.project[:30] + '-restore-' + identity[:12]
        labels = {'io.tavern.restore-of': self.project, 'io.tavern.managed': 'true', 'com.docker.compose.project': target_project}
        work = self.root / ('restore-' + identity)
        work.mkdir(mode=0o700)
        helper = postgres = None
        try:
            manifest = verify_archive(backup, work)
            images = manifest.get('images', {})
            if not all(key in images for key in ('init', 'postgres')):
                raise ValueError('This backup was made with the host helper. Restore it using that helper on an isolated project.')
            # Images must still be available locally; never pull an archive-supplied URL.
            for key in ('init', 'postgres'):
                if not re.fullmatch(r'sha256:[a-f0-9]{64}', images[key].get('id', '')):
                    raise ValueError('Backup image identity is invalid.')
                self.engine.images.get(images[key]['id'])
            directories = {'synapse': 'synapse', 'secrets': 'secrets', 'calls': 'calls', 'api': 'api',
                           'integrations-config': 'integrations_config', 'integrations-data': 'integrations_data', 'postgres': 'postgres_data'}
            volumes = {key: target_project + '_' + value for key, value in directories.items()}
            for volume in volumes.values():
                # Never adopt a preexisting volume, even when an ID collision occurs.
                if self.engine.volumes.list(filters={'name': volume}):
                    raise ValueError('Restore destination already exists. Choose a new restore operation.')
                self.engine.volumes.create(name=volume, labels=labels)
            mounts = [docker.types.Mount('/state/' + key, volume, type='volume') for key, volume in volumes.items()]
            storage = self.worker_mount()
            mounts.append(docker.types.Mount('/work', storage.get('Name') or storage['Source'], type=storage['Type'], read_only=True))
            helper = self.engine.containers.create(images['init']['id'], command=['/app/state_archive.py', 'restore-file', '/work/restore-' + identity + '/state.tar.gz'],
                entrypoint=['python'], network_mode='none', mounts=mounts, read_only=True, user='0:0', cap_drop=['ALL'],
                cap_add=['CHOWN', 'DAC_OVERRIDE', 'FOWNER'], security_opt=['no-new-privileges:true'], labels=labels)
            helper.start()
            if helper.wait(timeout=3600)['StatusCode'] != 0:
                raise ValueError('Restore failed while extracting state. The isolated volumes remain for inspection; production was unchanged.')
            postgres = self.engine.containers.create(images['postgres']['id'], name=target_project + '-postgres', network_mode='none',
                environment={'POSTGRES_USER': 'synapse', 'POSTGRES_DB': 'synapse', 'POSTGRES_PASSWORD_FILE': '/run/secrets/db_password', 'POSTGRES_INITDB_ARGS': '--encoding=UTF8 --locale=C'},
                mounts=[docker.types.Mount('/var/lib/postgresql/data', volumes['postgres']), docker.types.Mount('/run/secrets', volumes['secrets'], read_only=True)], labels=labels)
            postgres.start()
            for _ in range(120):
                if postgres.exec_run(['pg_isready', '-U', 'synapse', '-d', 'synapse']).exit_code == 0:
                    break
                time.sleep(1)
            else:
                raise ValueError('The isolated restore database did not become ready.')
            dump_tar = work / 'dump.tar'
            with tarfile.open(dump_tar, 'w') as archive:
                archive.add(work / 'synapse.dump', arcname='tavern-restore.dump', recursive=False)
            with dump_tar.open('rb') as archive:
                postgres.put_archive('/tmp', archive)
            result = postgres.exec_run(['pg_restore', '-U', 'synapse', '-d', 'synapse', '--no-owner', '--single-transaction', '/tmp/tavern-restore.dump'])
            if result.exit_code != 0:
                raise ValueError('The isolated database restore failed. Production data was unchanged.')
            return {'project': target_project, 'volumes': volumes, 'backupId': backup_id,
                    'message': 'Backup restored to an isolated, stopped copy. Validate it before switching traffic; production was unchanged.'}
        finally:
            if helper is not None:
                try:
                    helper.remove(force=True, v=False)
                except Exception:
                    LOG.warning('Isolated restore helper cleanup failed.')
            if postgres is not None:
                try:
                    postgres.remove(force=True, v=False)
                except Exception:
                    LOG.warning('Isolated restore database cleanup failed; production was unchanged.')
            shutil.rmtree(work)

    def release(self, version):
        version = allowed_release(version)
        release = read_json(f'https://api.github.com/repos/{REPOSITORY}/releases/tags/v{version}')
        if release.get('draft') or release.get('tag_name') != 'v' + version:
            raise ValueError('Only published Tavern releases may be installed.')
        current_minor = tuple(os.environ.get('TAVERN_VERSION', '0.4.0').split('.')[:2])
        if tuple(version.split('.')[:2]) != current_minor:
            raise ValueError('Automatic updates are limited to the current major/minor release line. Review schema changes and upgrade other releases manually.')
        return version

    def clone_config(self, container, image):
        self.check(container)
        config = copy.deepcopy(container.attrs['Config'])
        config['Image'] = image
        config['Hostname'] = ''
        # Release metadata comes from the new image, not the preceding image.
        config['Env'] = [item for item in config.get('Env', []) if item.split('=', 1)[0] not in {'TAVERN_VERSION', 'TAVERN_COMMIT', 'TAVERN_BUILD_DATE', 'TAVERN_CHANNEL', 'TAVERN_IMAGE_TAG'}]
        config['HostConfig'] = copy.deepcopy(container.attrs['HostConfig'])
        config['HostConfig'].pop('ContainerIDFile', None)
        networks = container.attrs['NetworkSettings']['Networks']
        config['NetworkingConfig'] = {'EndpointsConfig': {name: {'Aliases': [alias for alias in detail.get('Aliases') or [] if alias not in {container.id, container.short_id, container.name}]}
                                                         for name, detail in networks.items()}}
        return config

    def update(self, identity, version):
        version = self.release(version)
        containers = self.containers()
        for service, prefix in UPDATE_IMAGES.items():
            if service not in containers or not containers[service].attrs['Config']['Image'].startswith(prefix + ':'):
                raise ValueError('Automatic updates require both web and API to use the configured official GHCR release images. Source-build deployments update through Git.')
        backup = self.backup(identity)
        for prefix in UPDATE_IMAGES.values():
            self.engine.images.pull(prefix + ':' + version)
        changed = []
        try:
            for service in ('tavern-api', 'tavern-web'):
                old = containers[service]
                self.check(old)
                name = old.name
                config = self.clone_config(old, UPDATE_IMAGES[service] + ':' + version)
                networks = copy.deepcopy(old.attrs['NetworkSettings']['Networks'])
                changed.append((old, name, networks, None))
                old.stop(timeout=30)
                old.rename(name + '-rollback-' + identity[:12])
                for network in networks:
                    self.engine.networks.get(network).disconnect(old)
                created = self.engine.api.create_container_from_config(config, name=name)
                new = self.engine.containers.get(created['Id'])
                changed[-1] = (old, name, networks, new)
                new.start()
                for _ in range(180):
                    new.reload()
                    state = new.attrs['State']
                    if state.get('Health', {}).get('Status') == 'healthy':
                        break
                    if state.get('Status') in ('exited', 'dead'):
                        raise ValueError('Updated container exited before becoming healthy.')
                    time.sleep(1)
                else:
                    raise ValueError('Updated container did not pass its health check.')
        except Exception:
            recovery_failed = False
            for old, name, networks, new in reversed(changed):
                try:
                    if new is not None:
                        new.remove(force=True, v=False)
                    old.reload()
                    if old.name != name:
                        old.rename(name)
                    for network, config in networks.items():
                        if network not in old.attrs['NetworkSettings']['Networks']:
                            self.engine.networks.get(network).connect(old, aliases=config.get('Aliases') or [])
                    old.start()
                except Exception:
                    recovery_failed = True
                    LOG.error('A prior application container could not be restored after update failure.')
            if recovery_failed:
                raise ValueError('Update failed and automatic container recovery was incomplete. Inspect the Docker host; the pre-update backup remains available.') from None
            raise ValueError('Update failed and prior application containers were restarted. The pre-update backup remains available.') from None
        for old, _, _, _ in changed:
            try:
                old.remove(v=False)
            except Exception:
                LOG.warning('Updated services are healthy; a stopped rollback container needs cleanup.')
        return {'version': version, **backup, 'components': list(UPDATE_IMAGES)}

    async def submit(self, kind, payload):
        if self.lock.locked() or (self.task and not self.task.done()):
            raise ValueError('An operation is already running. Wait for it to finish.')
        if kind == 'update':
            current = self.get('installed_version', os.environ.get('TAVERN_VERSION', '0.4.0'))
            if version_order(payload['version']) <= version_order(current):
                raise ValueError('Choose a newer release. Downgrades require a reviewed restore and are not performed automatically.')
        identity = secrets.token_hex(16)
        self.db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)', (identity, kind, 'queued', time.time(), time.time(), '{}'))
        self.task = asyncio.create_task(self.execute(identity, kind, payload))
        return identity

    async def execute(self, identity, kind, payload):
        async with self.lock:
            # Let the API return the durable job ID before a consistent backup
            # intentionally pauses the API and gateway containers.
            await asyncio.sleep(1)
            self.db.execute("UPDATE jobs SET state='running',updated=? WHERE id=?", (time.time(), identity))
            try:
                if kind == 'backup':
                    result = await asyncio.to_thread(self.backup, identity)
                elif kind == 'restore':
                    result = await asyncio.to_thread(self.restore_copy, identity, payload['backupId'])
                elif kind == 'update':
                    result = await asyncio.to_thread(self.update, identity, payload['version'])
                else:
                    raise ValueError('Unknown operation.')
                self.db.execute("UPDATE jobs SET state='complete',updated=?,result=? WHERE id=?", (time.time(), json.dumps(result), identity))
                if kind == 'update':
                    self.set('installed_version', result['version'])
                if kind in ('backup', 'update'):
                    retention = self.get('settings', DEFAULT_SETTINGS)['retention']
                    for backup in self.backup_list()[retention:]:
                        self.archive_path(backup['id']).unlink()
            except Exception as error:
                message = str(error) if isinstance(error, ValueError) else 'Docker operation failed. Inspect the operations worker logs and container state.'
                LOG.error('Operation %s failed (%s)', identity, type(error).__name__)
                self.db.execute("UPDATE jobs SET state='failed',updated=?,result=? WHERE id=?", (time.time(), json.dumps({'error': message}), identity))

    async def schedule(self):
        while True:
            current = datetime.now(timezone.utc)
            settings = self.get('settings', DEFAULT_SETTINGS)
            for kind, enabled, setting in (('backup', 'backupEnabled', 'backupTime'), ('update', 'autoUpdateEnabled', 'updateTime')):
                key = 'scheduled_' + kind
                day = current.strftime('%Y-%m-%d')
                if settings[enabled] and current.strftime('%H:%M') == settings[setting] and self.get(key) != day and not self.lock.locked():
                    try:
                        payload = {}
                        if kind == 'update':
                            releases = await asyncio.to_thread(read_json, f'https://api.github.com/repos/{REPOSITORY}/releases?per_page=30')
                            current = self.get('installed_version', os.environ.get('TAVERN_VERSION', '0.4.0'))
                            candidates = [row for row in releases if not row.get('draft') and (settings['channel'] == 'prerelease' or not row.get('prerelease')) and re.fullmatch(r'v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', row.get('tag_name', '')) and row['tag_name'][1:].split('.')[:2] == current.split('.')[:2]]
                            if not candidates:
                                raise ValueError('No matching published release exists.')
                            payload = {'version': max(candidates, key=lambda row: version_order(row['tag_name'][1:]))['tag_name'][1:]}
                            if version_order(payload['version']) <= version_order(current):
                                self.set(key, day)
                                continue
                        await self.submit(kind, payload)
                        self.set(key, day)
                    except Exception:
                        LOG.warning('Scheduled %s could not start', kind)
                        self.set(key, day)
            await asyncio.sleep(30)


def create_app(directory=None, project=None, engine=None, token=None):
    secret = token or Path(os.environ.get('OPERATIONS_TOKEN_FILE', '/config/token')).read_text().strip()
    if len(secret) < 40:
        raise ValueError('Operations token is missing or invalid. Run the initializer.')
    operator = Operator(directory or os.environ.get('OPERATIONS_DATA_DIR', '/data'), project or os.environ.get('TAVERN_PROJECT', 'tavern'), engine)

    @web.middleware
    async def security(request, handler):
        if request.path != '/health' and not hmac.compare_digest(request.headers.get('Authorization', '').encode(), ('Bearer ' + secret).encode()):
            return web.json_response({'error': 'Unauthorized'}, status=401)
        try:
            return await handler(request)
        except web.HTTPException:
            raise
        except ValueError as error:
            return web.json_response({'error': str(error)}, status=400)
        except Exception:
            LOG.error('Operations request failed', exc_info=False)
            return web.json_response({'error': 'Operations service is unavailable.'}, status=503)

    app = web.Application(middlewares=[security], client_max_size=32768)
    app['operator'] = operator

    async def state(request):
        jobs = [{**dict(row), 'result': json.loads(row['result'])} for row in operator.db.execute('SELECT * FROM jobs ORDER BY created DESC LIMIT 20')]
        return web.json_response({'available': True, 'backups': operator.backup_list(), 'jobs': jobs, 'settings': operator.get('settings', DEFAULT_SETTINGS), 'project': operator.project})

    async def settings(request):
        if request.method == 'PUT':
            value = validate_settings(await request.json())
            if value['autoUpdateEnabled']:
                containers = await asyncio.to_thread(operator.containers)
                if any(name not in containers or not containers[name].attrs['Config']['Image'].startswith(prefix + ':') for name, prefix in UPDATE_IMAGES.items()):
                    raise ValueError('Automatic updates require official GHCR release images for web and API.')
            operator.set('settings', value)
        return web.json_response(operator.get('settings', DEFAULT_SETTINGS))

    async def backup(request):
        return web.json_response({'jobId': await operator.submit('backup', {})}, status=202)

    async def download(request):
        path = operator.archive_path(request.match_info['identity'])
        return web.FileResponse(path, headers={'Content-Disposition': 'attachment; filename="' + path.name + '"', 'Cache-Control': 'no-store'})

    async def delete(request):
        if operator.lock.locked():
            raise ValueError('Wait until the running operation completes.')
        operator.archive_path(request.match_info['identity']).unlink()
        return web.json_response({'deleted': True})

    async def restore(request):
        data = await request.json()
        if not isinstance(data, dict) or data.get('confirmation') != 'RESTORE TO ISOLATED COPY':
            raise ValueError('Type RESTORE TO ISOLATED COPY to create a stopped restoration in new volumes.')
        identity = request.match_info['identity']
        operator.archive_path(identity)
        return web.json_response({'jobId': await operator.submit('restore', {'backupId': identity})}, status=202)

    async def update(request):
        data = await request.json()
        if not isinstance(data, dict) or data.get('confirmation') != 'UPDATE TAVERN':
            raise ValueError('Type UPDATE TAVERN to back up and replace the Tavern application containers.')
        version = allowed_release(data.get('version'))
        return web.json_response({'jobId': await operator.submit('update', {'version': version})}, status=202)

    async def job(request):
        row = operator.db.execute('SELECT * FROM jobs WHERE id=?', (request.match_info['identity'],)).fetchone()
        if not row:
            raise web.HTTPNotFound()
        return web.json_response({**dict(row), 'result': json.loads(row['result'])})

    async def health(request):
        return web.json_response({'status': 'ok'})

    async def start(app):
        app['scheduler'] = asyncio.create_task(operator.schedule())

    async def close(app):
        app['scheduler'].cancel()
        if operator.task:
            await operator.task
        operator.engine.close()
        operator.db.close()

    app.add_routes([web.get('/health', health), web.get('/state', state),
                    web.get('/settings', settings), web.put('/settings', settings), web.post('/backups', backup),
                    web.get('/backups/{identity}/download', download), web.delete('/backups/{identity}', delete),
                    web.post('/backups/{identity}/restore', restore), web.post('/updates/apply', update), web.get('/jobs/{identity}', job)])
    app.on_startup.append(start)
    app.on_cleanup.append(close)
    return app


if __name__ == '__main__':
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO)
    web.run_app(create_app(), host='0.0.0.0', port=8091, access_log=None)
