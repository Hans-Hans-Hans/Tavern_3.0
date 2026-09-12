"""Historical artifact fixture, never a supported provisioning entry point."""
import json

def write_legacy_calls(root):
    calls=root/'calls';calls.mkdir(mode=0o700,exist_ok=True)
    config_path=root/'synapse/homeserver.yaml'
    config=json.loads(config_path.read_text())
    turn_secret='fixture-turn-secret-not-a-production-credential'
    key='fixture-livekit-key-not-a-production-credential'
    secret='fixture-livekit-secret-not-a-production-credential'
    livekit={'port':7880,'rtc':{'tcp_port':7881,'udp_port':7882,'use_external_ip':False,'node_ip':'8.8.8.8',
        'stun_servers':['turn.example.test:3478'],'turn_servers':[{'host':'turn.example.test','port':3478,'protocol':'udp','secret':turn_secret,'ttl':3600}]},
        'room':{'auto_create':False},'keys':{key:secret},'logging':{'level':'warn'}}
    (calls/'livekit.yaml').write_text(json.dumps(livekit)+'\n')
    (calls/'turnserver.conf').write_text('listening-port=3478\nrealm=turn.example.test\nstatic-auth-secret='+turn_secret+'\n')
    (calls/'jwt.env').write_text('LIVEKIT_URL=http://livekit:7880\nLIVEKIT_KEY='+key+'\nLIVEKIT_SECRET='+secret+'\n')
    (calls/'homeserver.before-calls.json').write_text(json.dumps(config)+'\n')
    config['turn_shared_secret']=turn_secret
    config['turn_uris']=['turn:turn.example.test:3478?transport=udp','turn:turn.example.test:3478?transport=tcp']
    config_path.write_text(json.dumps(config)+'\n')
