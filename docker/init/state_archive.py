#!/usr/bin/env python3
"""Stream persistent Tavern files for host-controlled backup and empty-state restore."""
import os
from itertools import chain
from pathlib import Path, PurePosixPath
import sys
import tarfile

DIRECTORIES = ('synapse', 'secrets', 'calls', 'api', 'integrations-config', 'integrations-data')


def safe_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] not in DIRECTORIES or '\\' in name:
        raise ValueError('Backup contains an unsafe or unexpected file path.')
    return path


def export_state(root, stream):
    with tarfile.open(fileobj=stream, mode='w|gz') as archive:
        for directory in DIRECTORIES:
            base = root / directory
            if not base.exists():
                continue
            for path in chain((base,), base.rglob('*')):
                if path.is_symlink() or (not path.is_dir() and not path.is_file()):
                    raise ValueError('Backups refuse links and special files; review persistent state.')
                archive.add(path, arcname=path.relative_to(root).as_posix(), recursive=False)


def restore_state(root, stream):
    postgres = root / 'postgres'
    if postgres.exists() and any(postgres.iterdir()):
        raise ValueError('Restore requires an empty PostgreSQL volume. Use an isolated new Compose project.')
    for directory in DIRECTORIES:
        path = root / directory
        if path.exists() and any(path.iterdir()):
            raise ValueError('Restore requires empty persistent volumes. Use an isolated new Compose project; existing data was not overwritten.')
    with tarfile.open(fileobj=stream, mode='r|gz') as archive:
        for member in archive:
            relative = safe_name(member.name)
            if not member.isdir() and not member.isfile():
                raise ValueError('Backups may contain only regular files and directories.')
            target = root.joinpath(*relative.parts)
            if target.is_symlink():
                raise ValueError('Restore target contains a symbolic link.')
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as output, archive.extractfile(member) as source:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
            os.chmod(target, member.mode & 0o777)
            if hasattr(os, 'geteuid') and os.geteuid() == 0:
                uid = 991 if relative.parts[0] == 'synapse' else 10001 if relative.parts[0] in ('api', 'integrations-data', 'integrations-config') else 0
                os.chown(target, uid, uid)


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['export']:
            export_state(Path('/state'), sys.stdout.buffer)
        elif sys.argv[1:] == ['restore']:
            restore_state(Path('/state'), sys.stdin.buffer)
        elif len(sys.argv) == 3 and sys.argv[1] == 'restore-file':
            with Path(sys.argv[2]).open('rb') as source:
                restore_state(Path('/state'), source)
        else:
            raise ValueError('Choose export or restore.')
    except (OSError, ValueError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
