#!/usr/bin/env python3
"""Add self-hosted TURN and MatrixRTC to an existing Tavern instance."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil

def prepare():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir',default='/opt/tavern-data')
    parser.add_argument('--turn-domain',required=True)
    parser.add_argument('--public-ip',required=True,help='Public IPv4 forwarded to this Docker host')
    args=parser.parse_args()
    ip=ipaddress.ip_address(args.public_ip)
    if ip.version!=4 or not ip.is_global: parser.error('Use your public, globally routable IPv4 address.')
    if not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]+',args.turn_domain): parser.error('Use a lowercase TURN DNS hostname.')
    data=Path(args.data_dir).resolve(); config_path=data/'synapse/homeserver.yaml'
    if not config_path.is_file(): parser.error('Prepare Tavern first.')
    if (data/'calls').exists(): parser.error('Call configuration already exists; refusing to overwrite keys.')
    config=json.loads(config_path.read_text()); domain=config['server_name']
    os.umask(0o077); (data/'calls').mkdir(mode=0o700)
    turn_secret=secrets.token_urlsafe(48); key=secrets.token_urlsafe(20); secret=secrets.token_urlsafe(48)
    turn=['listening-port=3478','listening-ip=0.0.0.0',f'external-ip={ip}',f'realm={args.turn_domain}',
          'fingerprint','use-auth-secret',f'static-auth-secret={turn_secret}','min-port=49160','max-port=49200',
          'no-cli','no-multicast-peers','no-tcp-relay','no-tls','no-dtls','stale-nonce=600','user-quota=12','total-quota=120',
          'log-file=stdout','simple-log','no-software-attribute','pidfile=/tmp/turn.pid' ]
    # Deny relay access to internal destinations, including IPv4-mapped IPv6.
    for network in ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','224.0.0.0/4','240.0.0.0/4','::/128','::1/128','fc00::/7','fe80::/10','ff00::/8','::ffff:0:0/96']:
        n=ipaddress.ip_network(network);turn.append(f'denied-peer-ip={n.network_address}-{n.broadcast_address}')
    turn.append(f'allowed-peer-ip={ip}')
    (data/'calls/turnserver.conf').write_text('\n'.join(turn)+'\n')
    livekit={'port':7880,'rtc':{'tcp_port':7881,'udp_port':7882,'use_external_ip':False,'node_ip':str(ip),
        'stun_servers':[f'{args.turn_domain}:3478'],
        'turn_servers':[{'host':args.turn_domain,'port':3478,'protocol':'udp','secret':turn_secret,'ttl':3600}]},
        'room':{'auto_create':False},'keys':{key:secret},'logging':{'level':'warn'}}
    (data/'calls/livekit.yaml').write_text(json.dumps(livekit,indent=2)+'\n')
    (data/'calls/jwt.env').write_text(f'LIVEKIT_URL=wss://{domain}/livekit/sfu\nLIVEKIT_KEY={key}\nLIVEKIT_SECRET={secret}\nLIVEKIT_FULL_ACCESS_HOMESERVERS={domain}\nLIVEKIT_JWT_BIND=:8080\n')
    config.update({'turn_uris':[f'turn:{args.turn_domain}:3478?transport=udp',f'turn:{args.turn_domain}:3478?transport=tcp'],
        'turn_shared_secret':turn_secret,'turn_user_lifetime':'1h','turn_allow_guests':False,'max_event_delay_duration':'24h',
        'matrix_rtc':{'transports':[{'type':'livekit','livekit_service_url':f'https://{domain}/livekit/jwt'}]}})
    config.setdefault('experimental_features',{}).update({'msc3266_enabled':True,'msc4143_enabled':True,'msc4222_enabled':True})
    config['rc_message']={'per_second':0.5,'burst_count':30};config['rc_delayed_event_mgmt']={'per_second':1,'burst_count':20}
    for listener in config['listeners']:
        for resource in listener.get('resources',[]):
            if 'client' in resource['names'] and 'openid' not in resource['names']: resource['names'].append('openid')
    shutil.copy2(config_path,data/'calls/homeserver.before-calls.json')
    config_path.write_text(json.dumps(config,indent=2)+'\n')
    print('Prepared call services. Restart Synapse and deploy compose.calls.yaml with the base stack.')
    print('Forward TURN 3478 TCP/UDP, UDP49160–49200, LiveKit TCP7881/UDP7882 to the Docker host.')

if __name__=='__main__': prepare()
