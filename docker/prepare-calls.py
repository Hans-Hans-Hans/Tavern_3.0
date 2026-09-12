#!/usr/bin/env python3
"""Unsupported legacy entry point; never creates or changes configuration."""
import sys

def prepare():
    print('docker/prepare-calls.py is retired. Use root compose.yaml and its init service. '
          'Set CALLS_ENABLED=true, COMPOSE_PROFILES=calls, TURN_DOMAIN and PUBLIC_IP '
          'in the existing deployment, then follow docs/INSTALLATION.md. '
          'Existing identities and call secrets must be preserved. No files were changed.', file=sys.stderr)
    return 64

if __name__ == '__main__':
    raise SystemExit(prepare())
