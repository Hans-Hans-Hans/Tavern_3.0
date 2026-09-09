"""CI-only exercise of the authenticated worker on its own isolated Docker host."""
import json
import os
from pathlib import Path
import tempfile
import time
from urllib.request import Request, urlopen
from archive_host import verify_archive

token = Path(os.environ.get('OPERATIONS_TOKEN_FILE', '/config/token')).read_text().strip()


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


backup = complete(request('/backups', {})['jobId'])
with tempfile.TemporaryDirectory() as target:
    verify_archive(Path('/data/backups') / (backup['backupId'] + '.tar'), Path(target))
restored = complete(request('/backups/' + backup['backupId'] + '/restore', {'confirmation': 'RESTORE TO ISOLATED COPY'})['jobId'])
assert restored['project'].startswith(os.environ.get('TAVERN_PROJECT', 'tavern')[:30] + '-restore-')
assert set(restored['volumes']) == {'synapse', 'secrets', 'calls', 'api', 'integrations-config', 'integrations-data', 'postgres'}
print('PASS: full managed backup, integrity verification, and restoration into isolated volumes.')
