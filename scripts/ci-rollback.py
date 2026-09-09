"""Real Docker rollback proof, restricted to an otherwise disposable CI daemon.

Release discovery and image downloads use pinned local fixtures. The production
Operator still performs its real scope checks, backup, replacements, health
checks, rollback and durable job recording. Nothing is published to GHCR.
"""
import asyncio
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid
from unittest.mock import patch

import docker

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'tavern-ci-rollback'
SOURCE_PROJECT = 'tavern-ci'
PROXY_NETWORK = 'tavern_ci_rollback_proxy'
SERVICES = ('init', 'postgres', 'synapse', 'tavern-api', 'tavern-web', 'operations')


def require_ci():
    if (os.environ.get('TAVERN_CI_SMOKE') != 'true'
            or os.environ.get('GITHUB_ACTIONS') != 'true'
            or sys.platform != 'linux'
            or Path(os.environ.get('GITHUB_WORKSPACE', '/missing')).resolve() != ROOT):
        raise RuntimeError('Rollback fixtures require this checkout on a disposable GitHub Actions Linux runner with TAVERN_CI_SMOKE=true.')


def containers(engine, project):
    result = {}
    for container in engine.containers.list(all=True, filters={'label': [
            'com.docker.compose.project=' + project, 'io.tavern.managed=true']}):
        container.reload()
        service = container.labels.get('com.docker.compose.service')
        if service in SERVICES:
            if service in result:
                raise RuntimeError('Duplicate CI fixture service: ' + service)
            result[service] = container
    if set(result) != set(SERVICES):
        raise RuntimeError('The canonical CI fixture services are incomplete.')
    return result


def snapshot(items):
    result = {}
    for service, container in items.items():
        container.reload()
        result[service] = (container.id, container.attrs['Image'], container.attrs['State']['StartedAt'])
    return result


def execute(container, command):
    result = container.exec_run(command)
    if result.exit_code != 0:
        raise RuntimeError('A rollback fixture command failed in ' + container.name)
    return result.output.decode().strip()


def healthy(container):
    for _ in range(120):
        container.reload()
        if container.attrs['State'].get('Health', {}).get('Status') == 'healthy':
            return
        if container.status in ('exited', 'dead'):
            raise RuntimeError('A rollback fixture exited: ' + container.name)
        time.sleep(1)
    raise RuntimeError('A rollback fixture did not recover its real health check: ' + container.name)


class LocalImages:
    """Only the two generated fixture tags replace network image downloads."""
    def __init__(self, real, pinned):
        self.real, self.pinned, self.pulled = real, pinned, []

    def pull(self, reference):
        if reference not in self.pinned:
            raise RuntimeError('Unexpected image download in the rollback fixture.')
        image = self.real.get(reference)
        if image.id != self.pinned[reference]:
            raise RuntimeError('The rollback fixture image identity changed.')
        self.pulled.append(reference)
        return image

    def __getattr__(self, name):
        return getattr(self.real, name)


class TrackedAPI:
    def __init__(self, engine, pinned):
        self.engine, self.pinned, self.created = engine, pinned, {}

    def create_container_from_config(self, config, name):
        labels = config.get('Labels', {})
        service = labels.get('com.docker.compose.service')
        if (labels.get('com.docker.compose.project') != PROJECT
                or labels.get('io.tavern.managed') != 'true'
                or service not in ('tavern-api', 'tavern-web')
                or name != PROJECT + '-' + service + '-1'):
            raise RuntimeError('Replacement attempted outside the exact rollback fixture.')
        if service == 'tavern-web':
            replacement_api = self.engine.containers.get(self.created['tavern-api'])
            replacement_api.reload()
            assert replacement_api.attrs['State']['Health']['Status'] == 'healthy'
            assert replacement_api.attrs['Image'] == self.pinned[replacement_api.attrs['Config']['Image']]
        created = self.engine.api.create_container_from_config(config, name=name)
        self.created[service] = created['Id']
        return created

    def __getattr__(self, name):
        return getattr(self.engine.api, name)


class FixtureEngine:
    def __init__(self, engine, pinned):
        self.real = engine
        self.images = LocalImages(engine.images, pinned)
        self.api = TrackedAPI(engine, pinned)

    def __getattr__(self, name):
        return getattr(self.real, name)


async def exercise(engine, source, initial, directory, pinned, version, base_version, proof):
    sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location('tavern_ci_operations', ROOT / 'ops/server.py')
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    fixture_engine = FixtureEngine(engine, pinned)
    operator = worker.Operator(directory, PROJECT, fixture_engine)
    operator.set('installed_version', base_version)
    expected_url = f'https://api.github.com/repos/{worker.REPOSITORY}/releases/tags/v{version}'

    def release(url):
        if url != expected_url:
            raise RuntimeError('Unexpected release lookup in the rollback fixture.')
        return {'tag_name': 'v' + version, 'draft': False, 'prerelease': True}

    try:
        started_at = int(time.time())
        with patch.object(worker, 'read_json', side_effect=release), patch.dict(os.environ, {'TAVERN_VERSION': base_version}):
            identity = await operator.submit('update', {'version': version})
            await operator.task
        row = operator.db.execute('SELECT state,result FROM jobs WHERE id=?', (identity,)).fetchone()
        assert row['state'] == 'failed', dict(row)
        assert json.loads(row['result'])['error'] == 'Update failed and prior application containers were restarted. The pre-update backup remains available.', dict(row)
        assert operator.get('installed_version') == base_version
        assert set(fixture_engine.images.pulled) == set(pinned)
        assert set(fixture_engine.api.created) == {'tavern-api', 'tavern-web'}
        deaths = list(engine.events(since=started_at, until=int(time.time()) + 1,
            filters={'container': fixture_engine.api.created['tavern-web'], 'event': 'die'}, decode=True))
        assert any(event.get('Actor', {}).get('Attributes', {}).get('exitCode') == '78' for event in deaths), 'The deliberately broken nginx image must actually start and exit.'
        for service, replacement in fixture_engine.api.created.items():
            assert replacement != initial[service].id
            try:
                engine.containers.get(replacement)
            except docker.errors.NotFound:
                pass
            else:
                raise RuntimeError('A failed replacement container was retained.')
        recovered = containers(engine, PROJECT)
        for service in ('tavern-api', 'tavern-web'):
            assert recovered[service].id == initial[service].id
            assert recovered[service].attrs['Image'] == initial[service].attrs['Image']
            healthy(recovered[service])
        for service in ('postgres', 'synapse'):
            healthy(recovered[service])
        # Static web health alone does not prove its restored network aliases
        # reach the API and homeserver after both replacements are removed.
        for path, required in (('/api/auth/config', 'bootstrapRequired'), ('/_matrix/client/versions', 'versions')):
            response = json.loads(execute(recovered['tavern-web'], ['wget', '-q', '-O', '-', 'http://127.0.0.1:8080' + path]))
            assert required in response
        assert execute(recovered['tavern-api'], ['python', '-c', 'import hashlib; from pathlib import Path; print(hashlib.sha256(Path("/data/tavern-ci-rollback-proof.bin").read_bytes()).hexdigest())']) == proof['file']
        assert execute(recovered['postgres'], ['psql', '-U', 'synapse', '-d', 'synapse', '-At', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT value FROM tavern_ci_rollback_proof']) == proof['value']
        assert execute(recovered['synapse'], ['python', '-c', 'import hashlib; from pathlib import Path; print(hashlib.sha256(Path("/data/server.signing.key").read_bytes()).hexdigest())']) == proof['identity']
        # Verify the actual pre-update backup, not merely its job metadata.
        with tempfile.TemporaryDirectory() as extracted:
            manifest = worker.verify_archive(operator.archive_path('tavern-' + identity), Path(extracted))
            for service in ('tavern-api', 'tavern-web'):
                assert manifest['images'][service]['id'] == initial[service].attrs['Image']
        assert snapshot(containers(engine, SOURCE_PROJECT)) == source
        print('PASS: a healthy replacement API followed by failed web startup restores both original application containers and health; file, SQL row, signing identity, pre-update backup, and primary stack remain intact.', flush=True)
    finally:
        operator.db.close()


def main():
    require_ci()
    engine = docker.from_env(timeout=120)
    owned_tags, started = [], False
    environment = None
    compose = ['docker', 'compose', '--project-name', PROJECT, '--file', str(ROOT / 'compose.yaml'), '--file', str(ROOT / 'scripts/ci-rollback-compose.yaml')]
    try:
        source = containers(engine, SOURCE_PROJECT)
        primary_before = snapshot(source)
        # Refuse to adopt or clean up a preexisting project, volume or network.
        if (engine.containers.list(all=True, filters={'label': 'com.docker.compose.project=' + PROJECT})
                or engine.volumes.list(filters={'label': 'com.docker.compose.project=' + PROJECT})
                or engine.networks.list(names=[PROXY_NETWORK, PROJECT + '_private', PROJECT + '_egress'])
                or any(volume.name.startswith(PROJECT + '_') for volume in engine.volumes.list())):
            raise RuntimeError('The rollback project must not already exist.')
        nonce = uuid.uuid4().hex
        base_version = '0.4.0'
        version = '0.4.999-ci-rollback.' + nonce
        prefixes = {'tavern-web': 'ghcr.io/hans-hans-hans/tavern', 'tavern-api': 'ghcr.io/hans-hans-hans/tavern-api'}
        old, pinned = {}, {}
        for service, prefix in prefixes.items():
            tag = '0.4.0-ci-base.' + nonce
            old[service] = prefix + ':' + tag
            image = engine.images.get(source[service].attrs['Image'])
            image.tag(prefix, tag=tag)
            owned_tags.append(old[service])
            assert engine.images.get(old[service]).id == image.id
            candidate = prefix + ':' + version
            dockerfile = 'FROM ' + old[service] + '\nLABEL io.tavern.ci-rollback="' + nonce + '"\n'
            if service == 'tavern-web':
                dockerfile += 'USER 0\nRUN printf \'#!/bin/sh\\nexit 78\\n\' > /usr/sbin/nginx && chmod 755 /usr/sbin/nginx\nUSER 101\n'
            else:
                dockerfile += 'ENV TAVERN_VERSION=' + version + '\n'
            candidate_image, _ = engine.images.build(fileobj=io.BytesIO(dockerfile.encode()), tag=candidate, pull=False, network_mode='none', rm=True)
            owned_tags.append(candidate)
            assert candidate_image.id != image.id
            assert engine.images.get(old[service]).id == image.id
            pinned[candidate] = candidate_image.id
        environment = {**os.environ, 'TAVERN_DOMAIN': 'rollback.example.test', 'TAVERN_PUBLIC_URL': 'https://rollback.example.test',
            'COMPOSE_PROJECT_NAME': PROJECT, 'COMPOSE_PROFILES': 'operations', 'OPERATIONS_ENABLED': 'true',
            'TAVERN_WEB_IMAGE': old['tavern-web'], 'TAVERN_API_IMAGE': old['tavern-api'],
            'TAVERN_INIT_IMAGE': source['init'].attrs['Image'], 'TAVERN_OPERATIONS_IMAGE': source['operations'].attrs['Image'],
            'SYNAPSE_IMAGE': source['synapse'].attrs['Image'], 'POSTGRES_IMAGE': source['postgres'].attrs['Image'],
            'TAVERN_DATA_DIR': '', 'TAVERN_INTEGRATIONS_CONFIG': 'integrations_config', 'TAVERN_INTEGRATIONS_DATA': 'integrations_data',
            'NPM_PROXY_EXTERNAL': 'false', 'NPM_PROXY_NETWORK': PROXY_NETWORK, 'CALLS_ENABLED': 'false', 'SFU_AUDIO_MODERATION_ENABLED': 'false', 'INTEGRATIONS_ENABLED': 'false', 'SMTP_ENABLED': 'false'}
        # Inspect the fully resolved model before creating project resources.
        model = json.loads(subprocess.check_output(compose + ['config', '--format', 'json'], cwd=ROOT, env=environment))
        assert model['name'] == PROJECT
        assert not model['services']['tavern-web'].get('ports')
        assert all(item.get('name', '').startswith(PROJECT + '_') for item in model['volumes'].values())
        assert all(item.get('name', '') in (PROXY_NETWORK, PROJECT + '_private', PROJECT + '_egress', PROJECT + '_media') for item in model['networks'].values())
        started = True
        subprocess.run(compose + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '240'], cwd=ROOT, env=environment, check=True)
        initial = containers(engine, PROJECT)
        value = uuid.uuid4().hex
        binary = bytes(range(256)) * 257 + value.encode()
        execute(initial['tavern-api'], ['python', '-c', 'from pathlib import Path; import sys; Path("/data/tavern-ci-rollback-proof.bin").write_bytes(bytes(range(256))*257+sys.argv[1].encode())', value])
        execute(initial['postgres'], ['psql', '-U', 'synapse', '-d', 'synapse', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE TABLE tavern_ci_rollback_proof(value TEXT NOT NULL); INSERT INTO tavern_ci_rollback_proof VALUES ('" + value + "')"])
        identity = execute(initial['synapse'], ['python', '-c', 'import hashlib; from pathlib import Path; print(hashlib.sha256(Path("/data/server.signing.key").read_bytes()).hexdigest())'])
        with tempfile.TemporaryDirectory(prefix=PROJECT + '-') as directory:
            asyncio.run(exercise(engine, primary_before, initial, directory, pinned, version, base_version, {'value': value, 'file': hashlib.sha256(binary).hexdigest(), 'identity': identity}))
    finally:
        if started:
            subprocess.run(compose + ['logs', '--tail', '40'], cwd=ROOT, env=environment, check=False)
            subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], cwd=ROOT, env=environment, check=True)
        for reference in reversed(owned_tags):
            engine.images.remove(reference, force=False, noprune=True)
        engine.close()


if __name__ == '__main__':
    main()
