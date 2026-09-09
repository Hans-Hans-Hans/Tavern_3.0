#!/usr/bin/env python3
"""Consistent backups and empty-state restore for the canonical Tavern Compose stack."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


class Operations:
    def __init__(self, compose_file, project=None):
        self.command = ['docker', 'compose', '-f', str(compose_file.resolve())]
        if project:
            self.command += ['-p', project]

    def run(self, *args, **options):
        return subprocess.run([*self.command, *args], check=True, **options)

    def running(self):
        return self.run('ps', '--status', 'running', '--services', capture_output=True, text=True).stdout.split()

    def backup(self, output):
        output = output.resolve()
        output.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Fail before stopping writes if the destination is already critically full.
        if shutil.disk_usage(output).free < 512 * 1024 * 1024:
            raise ValueError('Backup destination needs at least 512 MiB free; reserve enough space for your media and database.')
        running = self.running()
        if 'postgres' not in running:
            raise ValueError('Start the existing PostgreSQL service before backing up.')
        writers = [name for name in ('integrations', 'tavern-api', 'synapse') if name in running]
        timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        destination = output / f'tavern-{timestamp}.tar'
        pending = destination.with_suffix('.partial')
        with tempfile.TemporaryDirectory(prefix='.tavern-backup-', dir=output) as scratch:
            scratch = Path(scratch)
            try:
                if writers:
                    self.run('stop', '--timeout', '30', *writers)
                with (scratch / 'synapse.dump').open('wb') as target:
                    self.run('exec', '-T', 'postgres', 'pg_dump', '-U', 'synapse', '-Fc', 'synapse', stdout=target)
                with (scratch / 'state.tar.gz').open('wb') as target:
                    self.run('run', '--rm', '-T', '--no-deps', '--entrypoint', 'python', 'init', '/app/state_archive.py', 'export', stdout=target)
                manifest = {'format': 1, 'created_at': timestamp, 'files': {name: digest(scratch / name) for name in ('synapse.dump', 'state.tar.gz')}}
                (scratch / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
                with tarfile.open(pending, 'w') as archive:
                    os.chmod(pending, 0o600)
                    for name in ('manifest.json', 'synapse.dump', 'state.tar.gz'):
                        archive.add(scratch / name, arcname=name, recursive=False)
                pending.rename(destination)
            finally:
                if writers:
                    self.run('start', *reversed(writers))
                pending.unlink(missing_ok=True)
        print(f'Backup completed: {destination}')
        print('Archive contains identity keys and private data. Store it encrypted off-host with the deployment .env stored separately.')
        return destination

    def restore(self, backup):
        if self.running():
            raise ValueError('Restore requires an isolated, stopped Compose project with empty persistent volumes.')
        with tempfile.TemporaryDirectory(prefix='tavern-restore-') as temporary:
            temporary = Path(temporary)
            verify_archive(backup, temporary)
            # The helper rejects existing populated volumes before extracting data.
            with (temporary / 'state.tar.gz').open('rb') as source:
                self.run('run', '--rm', '-T', '--no-deps', '--entrypoint', 'python', 'init', '/app/state_archive.py', 'restore', stdin=source)
            self.run('up', '-d', '--no-deps', 'postgres')
            for _ in range(60):
                ready = subprocess.run([*self.command, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'synapse', '-d', 'synapse'], capture_output=True)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise ValueError('PostgreSQL did not become ready. Restored files remain in place; inspect its logs before proceeding.')
            with (temporary / 'synapse.dump').open('rb') as source:
                self.run('exec', '-T', 'postgres', 'pg_restore', '-U', 'synapse', '-d', 'synapse', '--no-owner', '--single-transaction', stdin=source)
        self.run('up', '-d')
        print('Restore completed. Verify accounts, messages, media, and encryption recovery before moving DNS.')


def verify_archive(backup, destination):
    expected = {'manifest.json', 'synapse.dump', 'state.tar.gz'}
    with tarfile.open(backup, 'r:') as archive:
        members = archive.getmembers()
        if len(members) != 3 or {member.name for member in members} != expected or any(not member.isfile() for member in members):
            raise ValueError('Invalid backup archive: expected three regular manifest/database/state files.')
        for member in members:
            with archive.extractfile(member) as source, (destination / member.name).open('xb') as target:
                shutil.copyfileobj(source, target, 1024 * 1024)
    manifest = json.loads((destination / 'manifest.json').read_text())
    if manifest.get('format') != 1 or set(manifest.get('files', {})) != expected - {'manifest.json'}:
        raise ValueError('Unsupported or incomplete backup manifest.')
    for name, expected_digest in manifest['files'].items():
        if digest(destination / name) != expected_digest:
            raise ValueError(f'Backup integrity check failed for {name}. Nothing has been restored.')
    # Validate every nested member before writing any persistent data.
    with tarfile.open(destination / 'state.tar.gz', 'r:gz') as archive:
        seen = set()
        for member in archive:
            from pathlib import PurePosixPath
            path = PurePosixPath(member.name)
            if (path.is_absolute() or '..' in path.parts or '\\' in member.name or not path.parts or
                    path.parts[0] not in {'synapse', 'secrets', 'calls', 'api', 'integrations-config', 'integrations-data'} or
                    not (member.isdir() or member.isfile()) or member.name in seen):
                raise ValueError('Unsafe persistent-state archive. Nothing has been restored.')
            seen.add(member.name)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compose-file', type=Path, default=Path(__file__).resolve().parents[1] / 'compose.yaml')
    parser.add_argument('--project', help='Retain the existing project for backup; use a new isolated name for restore.')
    commands = parser.add_subparsers(dest='action', required=True)
    backup = commands.add_parser('backup')
    backup.add_argument('--output', type=Path, required=True)
    restore = commands.add_parser('restore')
    restore.add_argument('--archive', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    operations = Operations(args.compose_file, args.project)
    try:
        if args.action == 'backup':
            operations.backup(args.output)
        else:
            operations.restore(args.archive)
    except (ValueError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        parser.exit(1, f'Tavern operations: {error}\n')


if __name__ == '__main__':
    main()
