"""CI-only exercise of the authenticated worker on its own isolated Docker host."""
import json
import hashlib
import os
from pathlib import Path
import tempfile
import time
import uuid
from urllib.request import Request, urlopen
import docker
from archive_host import verify_archive

if os.environ.get('TAVERN_CI_SMOKE') != 'true' or os.environ.get('TAVERN_PROJECT') != 'tavern-ci':
    raise RuntimeError('This destructive-fixture smoke script runs only on the isolated tavern-ci project with TAVERN_CI_SMOKE=true.')

token = Path(os.environ.get('OPERATIONS_TOKEN_FILE', '/config/token')).read_text().strip()
engine = docker.from_env()


def managed(service):
    containers = engine.containers.list(all=True, filters={'label': ['com.docker.compose.project=tavern-ci', 'io.tavern.managed=true', 'com.docker.compose.service=' + service]})
    if len(containers) != 1:
        raise RuntimeError('CI requires exactly one canonical ' + service + ' container.')
    return containers[0]


def execute(container, command):
    result = container.exec_run(command)
    if result.exit_code != 0:
        raise RuntimeError('An isolated CI fixture command failed.')
    return result.output.decode().strip()


def request(path, data=None):
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    with urlopen(Request('http://127.0.0.1:8091' + path, headers=headers, data=json.dumps(data).encode() if data is not None else None), timeout=30) as response:
        return json.load(response)


def complete(identity):
    for _ in range(180):
        result = request('/jobs/' + identity)
        if result['state'] == 'complete':
            return result['result']
        if result['state'] in ('failed', 'interrupted'):
            raise RuntimeError(result['result'])
        time.sleep(2)
    raise RuntimeError('Timed out waiting for the isolated CI operation.')


source_api, source_postgres, source_synapse, source_init = (managed(service) for service in ('tavern-api', 'postgres', 'synapse', 'init'))
fixture = uuid.uuid4().hex
table = 'tavern_ci_proof_' + fixture  # Generated hex only; never browser input.
binary = bytes(range(256)) * 257 + fixture.encode()
binary_digest = hashlib.sha256(binary).hexdigest()
proof_file = '/data/tavern-ci-backup-proof.bin'
identity_digest = execute(source_synapse, ['python', '-c', 'import hashlib; from pathlib import Path; print(hashlib.sha256(Path("/data/server.signing.key").read_bytes()).hexdigest())'])
clone_postgres = state_check = None
try:
    execute(source_api, ['python', '-c', 'from pathlib import Path; import sys; Path(sys.argv[1]).write_bytes(bytes(range(256))*257+sys.argv[2].encode())', proof_file, fixture])
    execute(source_postgres, ['psql', '-U', 'synapse', '-d', 'synapse', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE TABLE ' + table + " (value TEXT NOT NULL); INSERT INTO " + table + " VALUES ('" + fixture + "')"])
    backup = complete(request('/backups', {})['jobId'])
    with tempfile.TemporaryDirectory() as target:
        verify_archive(Path('/data/backups') / (backup['backupId'] + '.tar'), Path(target))
    restored = complete(request('/backups/' + backup['backupId'] + '/restore', {'confirmation': 'RESTORE TO ISOLATED COPY'})['jobId'])
    assert restored['project'].startswith('tavern-ci-restore-')
    volumes = restored['volumes']
    assert set(volumes) == {'synapse', 'secrets', 'calls', 'api', 'integrations-config', 'integrations-data', 'postgres'}
    assert all(name.startswith(restored['project'] + '_') for name in volumes.values())
    # Check the actual restored files using an isolated reader, not the source
    # archive or production volumes. JSON stdout contains digests only.
    state_check = engine.containers.create(source_init.attrs['Image'], entrypoint=['python'],
        command=['-c', 'import hashlib,json; from pathlib import Path; print(json.dumps({"api":hashlib.sha256(Path("/proof-api/tavern-ci-backup-proof.bin").read_bytes()).hexdigest(),"identity":hashlib.sha256(Path("/proof-synapse/server.signing.key").read_bytes()).hexdigest()}))'],
        network_mode='none', read_only=True, user='0:0', cap_drop=['ALL'], cap_add=['DAC_READ_SEARCH'], security_opt=['no-new-privileges:true'],
        mounts=[docker.types.Mount('/proof-api', volumes['api'], read_only=True), docker.types.Mount('/proof-synapse', volumes['synapse'], read_only=True)],
        labels={'io.tavern.ci-smoke': 'true'})
    state_check.start()
    assert state_check.wait(timeout=60)['StatusCode'] == 0
    assert json.loads(state_check.logs().decode()) == {'api': binary_digest, 'identity': identity_digest}
    clone_postgres = engine.containers.create(source_postgres.attrs['Image'], network_mode='none',
        environment={'POSTGRES_USER': 'synapse', 'POSTGRES_DB': 'synapse', 'POSTGRES_PASSWORD_FILE': '/run/secrets/db_password'},
        mounts=[docker.types.Mount('/var/lib/postgresql/data', volumes['postgres']), docker.types.Mount('/run/secrets', volumes['secrets'], read_only=True)],
        labels={'io.tavern.ci-smoke': 'true'})
    clone_postgres.start()
    for _ in range(120):
        if clone_postgres.exec_run(['pg_isready', '-h', '127.0.0.1', '-U', 'synapse', '-d', 'synapse']).exit_code == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('The restored CI database did not become ready.')
    assert execute(clone_postgres, ['psql', '-U', 'synapse', '-d', 'synapse', '-At', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT value FROM ' + table]) == fixture
    print('PASS: full backup and isolated restore preserve binary API files, PostgreSQL records, and the Synapse signing identity.')
finally:
    for container in (state_check, clone_postgres):
        if container is not None:
            container.remove(force=True, v=False)
    execute(source_postgres, ['psql', '-U', 'synapse', '-d', 'synapse', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP TABLE IF EXISTS ' + table])
    execute(source_api, ['python', '-c', 'from pathlib import Path; import sys; Path(sys.argv[1]).unlink(missing_ok=True)', proof_file])
    engine.close()
