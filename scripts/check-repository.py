#!/usr/bin/env python3
"""Check the Git index without printing credential contents. Standard library only."""
import re
import subprocess
import sys


def git(*args):
    return subprocess.run(['git', *args], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True).stdout


def main():
    paths = git('ls-files', '--cached', '-z').split(b'\0')
    ignored = git('ls-files', '--cached', '--ignored', '--exclude-standard', '-z')
    failures = [f'Ignored file is tracked: {p.decode()}' for p in ignored.split(b'\0') if p]
    patterns = {
        'private key': re.compile(rb'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----'),
        'GitHub token': re.compile(rb'\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b'),
        'AWS access key': re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
        'Slack token': re.compile(rb'\bxox[baprs]-[A-Za-z0-9-]{20,}\b'),
    }
    for path in filter(None, paths):
        name = path.decode()
        content = git('show', f':{name}')
        for label, pattern in patterns.items():
            if pattern.search(content):
                failures.append(f'Possible {label} in tracked file: {name}')
    if failures:
        print('\n'.join(sorted(set(failures))), file=sys.stderr)
        print('Remove private/generated files from the index. Rotate exposed credentials; '
              'ignore rules do not erase Git history.', file=sys.stderr)
        return 1
    print(f'Repository check passed: {sum(bool(p) for p in paths)} tracked files; '
          'no ignored files or selected credential patterns.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
