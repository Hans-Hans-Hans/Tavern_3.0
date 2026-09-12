import test from 'node:test';
import assert from 'node:assert/strict';
import {proveDirectEndpoint,directAudioSmoke,directAudioDiagnostic} from '../scripts/smoke-direct-audio.mjs';

test('failure diagnostics retain finite transport states and numeric counters without arbitrary text or addresses',()=>{
  assert.deepEqual(directAudioDiagnostic({'Connection':'connected','ICE transport':'completed','ICE gathering':'complete','Local route':'TURN relay',
    'Local ICE candidates':'2','Local relay candidates':'2','Remote ICE candidates':'4','Download media rate':'5.2 kbps','Upload media rate':'0 kbps'}),
    {connection:'connected',ice:'completed',gathering:'complete',route:'TURN relay',local:2,relay:2,remote:4,down:5.2,up:0});
  const value=directAudioDiagnostic({'Connection':'sensitive','ICE transport':'token-value','Local route':'192.0.2.4',
    'Local ICE candidates':'123456','Remote ICE candidates':{},'Download media rate':'123 token','Upload media rate':'Infinity kbps',cookie:'secret'});
  assert.equal(JSON.stringify(value),JSON.stringify(directAudioDiagnostic(null)));
});

function fixture(){
  const id='a'.repeat(64),networkId='b'.repeat(64);
  return {network:{Name:'tavern-ci_media',Id:networkId,Driver:'bridge',Scope:'local',Internal:true,EnableIPv6:false,
    Labels:{'com.docker.compose.project':'tavern-ci','com.docker.compose.network':'media'},IPAM:{Config:[{Subnet:'172.30.239.0/24'}]},
    Containers:{[id]:{Name:'tavern-ci-coturn-1',IPv4Address:'172.30.239.3/24'}}},
    container:{id,name:'/tavern-ci-coturn-1',image:'coturn/coturn:4.17.2-r0',running:true,ports:null,
      labels:{'com.docker.compose.project':'tavern-ci','com.docker.compose.service':'coturn'},
      command:['exec /usr/bin/turnserver -c /config/turnserver.ci.conf --relay-ip=172.30.239.3 --allowed-peer-ip=172.30.239.3'],
      networks:{'tavern-ci_media':{NetworkID:networkId,IPAddress:'172.30.239.3',IPPrefixLen:24,GlobalIPv6Address:''}}}};
}

test('direct audio requires its exact unpublished isolated TURN endpoint',()=>{
  const f=fixture();assert.doesNotThrow(()=>proveDirectEndpoint(f.network,f.container));
  for(const mutate of [f=>f.network.Internal=false,f=>f.container.ports={'3478/udp':[{}]},f=>f.container.command=['--dev'],
    f=>f.container.networks['tavern-ci_media'].IPAddress='1.1.1.1',f=>f.container.labels['com.docker.compose.project']='production',
    f=>f.container.networks.other={},f=>f.network.Id='invalid']){
    const changed=fixture();mutate(changed);assert.throws(()=>proveDirectEndpoint(changed.network,changed.container),/scope could not be verified/);
  }
});

test('direct audio refuses unscoped invocation before touching browsers or Docker',async()=>{
  let touched=false;
  await assert.rejects(directAudioSmoke({origin:'https://outside.invalid'}, {docker:async()=>{touched=true;}}),/scope could not be verified/);
  assert.equal(touched,false);
});
