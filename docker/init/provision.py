#!/usr/bin/env python3
"""Idempotent Compose provisioning. Existing homeserver identity always wins."""
import ipaddress
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import sys
import tempfile

import yaml


class ConfigurationError(ValueError):
    pass


def hostname(value, name):
    if len(value) > 253 or not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', value):
        raise ConfigurationError(f'{name} must be a lowercase DNS hostname without scheme, port, or path.')
    return value


def boolean(env, name, default='false'):
    value = env.get(name, default).lower()
    if value not in ('true', 'false'):
        raise ConfigurationError(f'{name} must be true or false.')
    return value == 'true'


def write_new(path, content, mode=0o600):
    """Never replace a secret; interrupted setup can safely resume."""
    if path.exists():
        return False
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='\n', dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, mode)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        # Atomic create without overwriting: the destination is never partial.
        os.link(temporary, path)
    except FileExistsError:
        return False
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return True


def private_secret(path):
    write_new(path, secrets.token_urlsafe(48) + '\n')
    value = path.read_text(encoding='utf-8').strip()
    if len(value) < 24 or '\n' in value:
        raise ConfigurationError(f'{path.name} is empty or invalid; restore the original secret from a backup.')
    return value


def own(path, uid):
    if hasattr(os, 'geteuid') and os.geteuid() == 0:
        os.chown(path, uid, uid)


def provision(root, env):
    domain = hostname(env.get('TAVERN_DOMAIN', ''), 'TAVERN_DOMAIN')
    public_url = env.get('TAVERN_PUBLIC_URL') or f'https://{domain}'
    if public_url.rstrip('/') != f'https://{domain}':
        raise ConfigurationError('TAVERN_PUBLIC_URL must be https://TAVERN_DOMAIN; retain the existing browser origin.')
    calls = boolean(env, 'CALLS_ENABLED')
    profiles = {p.strip() for p in env.get('COMPOSE_PROFILES', '').split(',') if p.strip()}
    if calls != ('calls' in profiles):
        raise ConfigurationError('Enable calls with both CALLS_ENABLED=true and COMPOSE_PROFILES=calls (comma-separated with other profiles).')
    audio_moderation = boolean(env, 'SFU_AUDIO_MODERATION_ENABLED')
    if audio_moderation and not calls:
        raise ConfigurationError('SFU_AUDIO_MODERATION_ENABLED requires CALLS_ENABLED=true and the calls profile.')
    operations = boolean(env, 'OPERATIONS_ENABLED')
    if operations != ('operations' in profiles):
        raise ConfigurationError('Enable the operations worker with both OPERATIONS_ENABLED=true and operations in COMPOSE_PROFILES.')
    integrations = boolean(env, 'INTEGRATIONS_ENABLED')
    if integrations != ('integrations' in profiles):
        raise ConfigurationError('Enable the webhook bot with both INTEGRATIONS_ENABLED=true and integrations in COMPOSE_PROFILES.')
    turn_domain, public_ip = '', ''
    if calls:
        turn_domain = hostname(env.get('TURN_DOMAIN', ''), 'TURN_DOMAIN')
        try:
            public_ip = ipaddress.ip_address(env.get('PUBLIC_IP', ''))
        except ValueError as exc:
            raise ConfigurationError('PUBLIC_IP must be the public IPv4 forwarded to this Docker host.') from exc
        if public_ip.version != 4 or not public_ip.is_global:
            raise ConfigurationError('PUBLIC_IP must be a globally routable IPv4 address.')
    # Validate all input before touching persistent files.
    level = env.get('LOG_LEVEL', 'WARNING').upper()
    if level not in ('DEBUG', 'INFO', 'WARNING', 'ERROR'):
        raise ConfigurationError('LOG_LEVEL must be DEBUG, INFO, WARNING, or ERROR.')
    os.umask(0o077)
    for directory in ('synapse', 'secrets', 'calls', 'api', 'integrations-config', 'integrations-data', 'operations', 'operations-secret'):
        (root / directory).mkdir(parents=True, exist_ok=True)
    synapse = root / 'synapse'
    config_path = synapse / 'homeserver.yaml'
    database_dir = root / 'postgres'
    if not config_path.exists() and database_dir.exists() and any(database_dir.iterdir()):
        raise ConfigurationError('PostgreSQL data exists but homeserver.yaml is missing. Restore the matching Synapse configuration; refusing to create a new identity or bootstrap account.')
    config = None
    if config_path.exists():
        config = yaml.safe_load(config_path.read_text(encoding='utf-8'))
        if not isinstance(config, dict) or config.get('server_name') != domain:
            raise ConfigurationError('TAVERN_DOMAIN differs from the existing Synapse server_name. Restore the original hostname; changing it breaks account identities.')
        if config.get('database', {}).get('name') != 'psycopg2':
            raise ConfigurationError('Existing Synapse database is not PostgreSQL. Complete a reviewed migration before using this stack.')
    password_path = root / 'secrets/db_password'
    if config is not None:
        existing_password = str(config.get('database', {}).get('args', {}).get('password', ''))
        if not existing_password:
            raise ConfigurationError('Existing Synapse configuration must contain its database password; no replacement secret has been generated.')
        write_new(password_path, existing_password + '\n')
        if password_path.read_text(encoding='utf-8').strip() != existing_password:
            raise ConfigurationError('Database password file and existing homeserver configuration differ. Restore matching configuration; passwords were not changed.')
    else:
        password = private_secret(password_path)
        config = {
            'server_name': domain, 'public_baseurl': f'https://{domain}/',
            'pid_file': '/data/homeserver.pid',
            'listeners': [{'port': 8008, 'tls': False, 'type': 'http', 'x_forwarded': True,
                           'bind_addresses': ['0.0.0.0'], 'resources': [{'names': ['client', 'openid'], 'compress': False}]}],
            'database': {'name': 'psycopg2', 'args': {'user': 'synapse', 'password': password,
                         'database': 'synapse', 'host': 'postgres', 'port': 5432, 'cp_min': 2, 'cp_max': 10}},
            'media_store_path': '/data/media_store', 'signing_key_path': '/data/server.signing.key',
            'registration_shared_secret': secrets.token_urlsafe(48),
            'macaroon_secret_key': secrets.token_urlsafe(48), 'form_secret': secrets.token_urlsafe(48),
            'enable_registration': False, 'allow_guest_access': False, 'enable_3pid_lookup': False,
            'url_preview_enabled': False, 'report_stats': False, 'federation_domain_whitelist': [],
            'trusted_key_servers': [], 'allow_public_rooms_without_auth': False,
            'allow_public_rooms_over_federation': False, 'max_upload_size': '10M',
            'log_config': '/data/log.config', 'suppress_key_server_warning': True,
            'rc_login': {'address': {'per_second': 0.17, 'burst_count': 20},
                         'account': {'per_second': 0.17, 'burst_count': 5},
                         'failed_attempts': {'per_second': 0.17, 'burst_count': 3}},
        }
        write_new(synapse / 'tavern-bootstrap-allowed', 'Fresh installation; setup may run once.\n', 0o640)
        write_new(config_path, json.dumps(config, indent=2) + '\n')
    write_new(synapse / 'log.config', json.dumps({'version': 1,
              'formatters': {'brief': {'format': '%(asctime)s %(levelname)s %(name)s: %(message)s'}},
              'handlers': {'console': {'class': 'logging.StreamHandler', 'formatter': 'brief'}},
              'root': {'level': level, 'handlers': ['console']}, 'disable_existing_loggers': False}, indent=2) + '\n')
    if calls:
        provision_calls(root, config, domain, turn_domain, str(public_ip))
    install_policy(root, config, integrations, audio_moderation)
    # Permissions only on known configuration files/directories; never walk existing media.
    for path in (synapse, config_path, synapse / 'log.config'):
        own(path, 991)
    os.chmod(synapse, 0o750)
    os.chmod(config_path, 0o640)
    if (synapse / 'tavern-bootstrap-allowed').exists():
        own(synapse / 'tavern-bootstrap-allowed', 991)
    # Docker secrets convention: only this directory is mounted into postgres.
    os.chmod(root / 'secrets', 0o755)
    os.chmod(password_path, 0o444)
    own(root / 'api', int(env.get('API_UID', '10001')))
    own(root / 'integrations-data', 10001)
    own(root / 'integrations-config', 10001)
    os.chmod(root / 'integrations-config', 0o750)
    if operations:
        private_secret(root / 'operations-secret/token')
        os.chmod(root / 'operations-secret', 0o755)
        os.chmod(root / 'operations-secret/token', 0o644)
    print('Tavern configuration validated. Existing identity, database credentials, and media preserved.')


def install_policy(root, config, integrations=False, audio_moderation=False):
    bundled = Path(__file__).parent / 'modules'
    if not bundled.exists():
        bundled = Path(__file__).resolve().parents[2] / 'synapse_modules'
    source = bundled / 'tavern_policy.py'
    if not source.is_file():
        raise ConfigurationError('Tavern permission module is missing from the init image. Rebuild the matching release before starting services.')
    target = root / 'synapse/tavern_modules'
    target.mkdir(exist_ok=True, mode=0o750)
    own(target, 991)
    # provision() uses umask 077: mkdir's mode alone would leave a new tree
    # at 0700. The API's supplementary Synapse group needs read/traverse access.
    # Also repair already-provisioned trees without widening any secret file.
    os.chmod(target, 0o750)
    privacy_key = root / 'synapse/tavern-privacy.key'
    write_new(privacy_key, secrets.token_hex(32) + '\n', 0o640)
    if not re.fullmatch(r'[0-9a-f]{64}', privacy_key.read_text(encoding='utf-8').strip()):
        raise ConfigurationError('tavern-privacy.key is invalid. Restore the existing consent-service key before starting.')
    os.chmod(privacy_key, 0o640)
    own(privacy_key, 991)
    for module in bundled.glob('*.py'):
        pending = target / (module.name + '.pending')
        shutil.copyfile(module, pending)
        os.chmod(pending, 0o640)
        own(pending, 991)
        pending.replace(target / module.name)
    modules = config.setdefault('modules', [])
    installed = next((item for item in modules if item.get('module') == 'tavern_policy.TavernPolicy'), None)
    privacy_config = {'privacy_api_url': 'http://tavern-api:8090', 'privacy_key_file': '/data/tavern-privacy.key',
                      'system_messages_enabled': integrations, 'audio_moderation_enabled': audio_moderation}
    if installed is None or any(installed.get('config', {}).get(key) != value for key, value in privacy_config.items()):
        # This one additive migration installs server-side authorization. Preserve
        # an exact before image; do not alter existing accounts, rooms, or keys.
        original = root / 'synapse/homeserver.yaml'
        backup = root / 'synapse/homeserver.before-policy.yaml'
        write_new(backup, original.read_text(encoding='utf-8'), 0o640)
        own(backup, 991)
        if installed is None:
            modules.append({'module': 'tavern_policy.TavernPolicy', 'config': privacy_config})
        else:
            installed.setdefault('config', {}).update(privacy_config)
        pending_config = root / 'synapse/homeserver.yaml.pending'
        pending_config.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
        pending_config.replace(original)


def client_openid_resources(config):
    """Validate without mutation, then return only client resources needing OpenID."""
    listeners = config.get('listeners', [])
    if not isinstance(listeners, list):
        raise ConfigurationError('Synapse listeners are invalid; restore the current configuration before enabling calls.')
    found, pending = False, []
    for listener in listeners:
        if not isinstance(listener, dict) or not isinstance(listener.get('resources', []), list):
            raise ConfigurationError('Synapse listener resources are invalid; configuration was not changed.')
        for resource in listener.get('resources', []):
            if not isinstance(resource, dict) or not isinstance(resource.get('names'), list) or any(not isinstance(name, str) for name in resource['names']):
                raise ConfigurationError('Synapse listener resource names are invalid; configuration was not changed.')
            if 'client' in resource['names']:
                found = True
                if 'openid' not in resource['names']:
                    pending.append(resource['names'])
    if not found:
        raise ConfigurationError('Calls require an existing Synapse client listener; configuration was not changed.')
    return pending


def migrate_existing_call_openid(root, config, resources):
    if not resources:
        return
    original = root / 'synapse/homeserver.yaml'
    before = original.read_bytes()
    if yaml.safe_load(before) != config:
        raise ConfigurationError('Synapse configuration changed during call validation. Retry without replacing the existing configuration.')
    backup = original.with_name('homeserver.before-openid-v1.yaml')
    if backup.exists() and backup.read_bytes() != before:
        backup = original.with_name('homeserver.before-openid-v1.' + hashlib.sha256(before).hexdigest() + '.yaml')
    # read_bytes/decode avoids newline normalization: this is the exact before
    # image, including operator comments. write_new never replaces any backup.
    write_new(backup, before.decode('utf-8'), 0o640)
    if backup.read_bytes() != before:
        raise ConfigurationError('The OpenID migration backup could not be verified; configuration was not changed.')
    own(backup, 991)
    for names in resources:
        names.append('openid')
    pending = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='\n', dir=original.parent, delete=False) as handle:
            pending = Path(handle.name)
            previous_stat = original.stat()
            os.chmod(pending, stat.S_IMODE(previous_stat.st_mode))
            if hasattr(os, 'geteuid') and os.geteuid() == 0:
                os.chown(pending, previous_stat.st_uid, previous_stat.st_gid)
            handle.write(json.dumps(config, indent=2) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        if original.read_bytes() != before:
            raise ConfigurationError('Synapse configuration changed during OpenID migration; the new operator configuration was preserved.')
        pending.replace(original)
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)


def provision_calls(root, config, domain, turn_domain, public_ip):
    call_dir = root / 'calls'
    openid_resources = client_openid_resources(config)
    # Legacy prepare-calls.py stores credentials in livekit.yaml and jwt.env.
    livekit_path = call_dir / 'livekit.yaml'
    turn_path = call_dir / 'turnserver.conf'
    if livekit_path.exists() or turn_path.exists():
        if not livekit_path.is_file() or not turn_path.is_file():
            raise ConfigurationError('Incomplete existing call configuration. Restore both livekit.yaml and turnserver.conf before enabling calls.')
        livekit = yaml.safe_load(livekit_path.read_text(encoding='utf-8'))
        turn_text = turn_path.read_text(encoding='utf-8')
        if not config.get('turn_shared_secret') or 'static-auth-secret=' + config['turn_shared_secret'] not in turn_text.splitlines():
            raise ConfigurationError('Existing TURN configuration and Synapse shared secret differ. Restore a matching configuration; credentials were not replaced.')
        if livekit.get('rtc', {}).get('node_ip') != public_ip or 'realm=' + turn_domain not in turn_text.splitlines():
            raise ConfigurationError('TURN_DOMAIN or PUBLIC_IP differs from existing call configuration. Retain the original settings or review and update the backed-up media configuration while services are stopped.')
        keys = livekit.get('keys', {})
        if len(keys) != 1:
            raise ConfigurationError('Expected one existing LiveKit key; review call credential migration manually.')
        key, secret = next(iter(keys.items()))
        # Reject mismatched existing sidecars before creating any missing one.
        for name, expected in (('livekit_key', key), ('livekit_secret', secret)):
            path = call_dir / name
            if path.exists() and path.read_text().strip() != expected:
                raise ConfigurationError('LiveKit credential files differ. Restore the matching files without rotating credentials.')
        write_new(call_dir / 'livekit_key', key + '\n', 0o644)
        write_new(call_dir / 'livekit_secret', secret + '\n', 0o644)
        if (call_dir / 'livekit_key').read_text().strip() != key or (call_dir / 'livekit_secret').read_text().strip() != secret:
            raise ConfigurationError('LiveKit credential files differ. Restore the matching files without rotating credentials.')
        for path in (call_dir,):
            os.chmod(path, 0o755)
        # The legacy CLI used umask 077. The SFU and API now run as UID
        # 10001, so repair only their runtime files to match fresh installs.
        # Keep private sidecars and all existing credential bytes untouched.
        for path in (livekit_path, call_dir / 'livekit_key', call_dir / 'livekit_secret'):
            os.chmod(path, 0o644)
        migrate_existing_call_openid(root, config, openid_resources)
        return
    turn_secret = private_secret(call_dir / 'turn_secret')
    key = private_secret(call_dir / 'livekit_key')
    secret = private_secret(call_dir / 'livekit_secret')
    # All call images must read config, regardless of their upstream UID. Mounts
    # are private to this stack, not public directories or web-served assets.
    os.chmod(call_dir, 0o755)
    for file in ('livekit_key', 'livekit_secret'):
        os.chmod(call_dir / file, 0o644)
    turn = ['listening-port=3478', 'listening-ip=0.0.0.0', f'external-ip={public_ip}', f'realm={turn_domain}',
            'fingerprint', 'use-auth-secret', f'static-auth-secret={turn_secret}', 'min-port=49160', 'max-port=49200',
            'no-cli', 'no-multicast-peers', 'no-tcp-relay', 'no-tls', 'no-dtls', 'stale-nonce=600',
            'user-quota=12', 'total-quota=120', 'log-file=stdout', 'simple-log', 'no-software-attribute', 'pidfile=/tmp/turn.pid']
    for network in ('0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
                    '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4', '::/128', '::1/128',
                    'fc00::/7', 'fe80::/10', 'ff00::/8', '::ffff:0:0/96'):
        net = ipaddress.ip_network(network)
        turn.append(f'denied-peer-ip={net.network_address}-{net.broadcast_address}')
    turn.append(f'allowed-peer-ip={public_ip}')
    livekit = {'port': 7880, 'rtc': {'tcp_port': 7881, 'udp_port': 7882, 'use_external_ip': False,
               'node_ip': public_ip, 'stun_servers': [f'{turn_domain}:3478'],
               'turn_servers': [{'host': turn_domain, 'port': 3478, 'protocol': 'udp', 'secret': turn_secret, 'ttl': 3600}]},
               'room': {'auto_create': False}, 'keys': {key: secret}, 'logging': {'level': 'warn'}}
    # Persist the before image before adding call-specific settings.
    write_new(call_dir / 'homeserver.before-calls.json', json.dumps(config, indent=2) + '\n')
    config.update({'turn_uris': [f'turn:{turn_domain}:3478?transport=udp', f'turn:{turn_domain}:3478?transport=tcp'],
                   'turn_shared_secret': turn_secret, 'turn_user_lifetime': '1h', 'turn_allow_guests': False,
                   'max_event_delay_duration': '24h',
                   'matrix_rtc': {'transports': [{'type': 'livekit', 'livekit_service_url': f'https://{domain}/livekit/jwt'}]}})
    config.setdefault('experimental_features', {}).update({'msc3266_enabled': True, 'msc4143_enabled': True, 'msc4222_enabled': True})
    config['rc_message'] = {'per_second': 0.5, 'burst_count': 30}
    config['rc_delayed_event_mgmt'] = {'per_second': 1, 'burst_count': 20}
    for names in openid_resources:
        names.append('openid')
    temporary = root / 'synapse/homeserver.yaml.pending'
    temporary.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    temporary.replace(root / 'synapse/homeserver.yaml')
    write_new(turn_path, '\n'.join(turn) + '\n', 0o644)
    write_new(livekit_path, json.dumps(livekit, indent=2) + '\n', 0o644)


if __name__ == '__main__':
    try:
        provision(Path(os.environ.get('TAVERN_STATE_ROOT', '/state')), os.environ)
    except (ConfigurationError, OSError, yaml.YAMLError) as error:
        print(f'Tavern setup: {error}', file=sys.stderr)
        sys.exit(64)
