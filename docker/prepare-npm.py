#!/usr/bin/env python3
"""Prepare a new, single-domain Tavern instance for an existing NPM deployment."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets

def prepare():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--domain', required=True, help='Public hostname; also the immutable Matrix account domain')
    parser.add_argument('--synapse-image', required=True, help='matrixdotorg/synapse:vX.Y.Z or a sha256 digest')
    parser.add_argument('--data-dir', default='/opt/tavern-data')
    parser.add_argument('--source-dir', default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument('--proxy-network', default='npm_proxy')
    args = parser.parse_args()
    hostname = r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
    if len(args.domain) > 253 or not re.fullmatch(hostname, args.domain):
        parser.error('Use a lowercase DNS hostname without a scheme, port, or path.')
    if not re.fullmatch(r'matrixdotorg/synapse:(?:v\d+\.\d+\.\d+)|matrixdotorg/synapse@sha256:[a-f0-9]{64}', args.synapse_image):
        parser.error('Pin an official Synapse release tag or sha256 digest. Do not use latest.')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', args.proxy_network):
        parser.error('Invalid Docker network name.')
    source, data = Path(args.source_dir).resolve(), Path(args.data_dir).resolve()
    if data.is_relative_to(source):
        parser.error('Keep the private data directory outside the source/build context.')
    for path in [source, data]:
        if not re.fullmatch(r'/[a-zA-Z0-9_./-]+', str(path)):
            parser.error('Use absolute paths without spaces, dollar signs, or shell punctuation.')
    if not (source / 'Dockerfile').is_file() or not (source / 'compose.yaml').is_file():
        parser.error('The source directory must contain Tavern Dockerfile and compose.yaml.')
    if (source / '.env').exists() or (source / '.env').is_symlink() or (data.exists() and any(data.iterdir())):
        parser.error('Configuration or data already exists. Refusing to overwrite secrets or server identity.')
    os.umask(0o077)
    (data / 'synapse').mkdir(parents=True, mode=0o700)
    (data / 'secrets').mkdir(mode=0o700)
    password = secrets.token_urlsafe(36)
    (data / 'secrets/db_password').write_text(password + '\n')
    config = {
        'server_name': args.domain, 'public_baseurl': f'https://{args.domain}/',
        'pid_file': '/data/homeserver.pid',
        'listeners': [{'port': 8008, 'tls': False, 'type': 'http', 'x_forwarded': True,
                       'bind_addresses': ['0.0.0.0'], 'resources': [{'names': ['client'], 'compress': False}]}],
        'database': {'name': 'psycopg2', 'args': {'user': 'synapse', 'password': password,
            'database': 'synapse', 'host': 'postgres', 'port': 5432, 'cp_min': 2, 'cp_max': 10}},
        'media_store_path': '/data/media_store', 'signing_key_path': '/data/server.signing.key',
        'registration_shared_secret': secrets.token_urlsafe(36),
        'macaroon_secret_key': secrets.token_urlsafe(36), 'form_secret': secrets.token_urlsafe(36),
        'enable_registration': False, 'allow_guest_access': False, 'enable_3pid_lookup': False,
        'url_preview_enabled': False, 'report_stats': False, 'federation_domain_whitelist': [],
        'trusted_key_servers': [], 'allow_public_rooms_without_auth': False,
        'allow_public_rooms_over_federation': False, 'max_upload_size': '10M',
        'log_config': '/data/log.config', 'suppress_key_server_warning': True,
        'rc_login': {'address': {'per_second': 0.17, 'burst_count': 20},
                     'account': {'per_second': 0.17, 'burst_count': 5},
                     'failed_attempts': {'per_second': 0.17, 'burst_count': 3}},
    }
    (data / 'synapse/homeserver.yaml').write_text(json.dumps(config, indent=2) + '\n')
    (data / 'synapse/log.config').write_text(json.dumps({'version': 1,
        'handlers': {'console': {'class': 'logging.StreamHandler'}},
        'root': {'level': 'WARNING', 'handlers': ['console']}, 'disable_existing_loggers': False}, indent=2) + '\n')
    (source / '.env').write_text(f'TAVERN_DOMAIN={args.domain}\nSYNAPSE_IMAGE={args.synapse_image}\n'
        f'TAVERN_DATA_DIR={data}\nTAVERN_SOURCE_DIR={source}\nNPM_PROXY_NETWORK={args.proxy_network}\nTAVERN_GIT_REF=V3\n')
    print(f'Prepared {args.domain}. Before startup: sudo chown -R 991:991 {data}/synapse')
    print('Keep the data directory private. See docs/DEPLOY_GITHUB.md for GitHub/Dockhand deployment.')

if __name__ == '__main__':
    prepare()
