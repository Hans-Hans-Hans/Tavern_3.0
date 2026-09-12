// Real Matrix SDK direct calls through the owned CI TURN server. The only
// microphone source is Chromium's verified synthetic capture device.
import { expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectSyntheticDevices, proveConferenceRoom } from './smoke-conference.mjs';
import { matrixSmokeRequest } from './matrix-smoke-request.mjs';
import { isCiRoomId } from './ci-room-id.mjs';

const ORIGIN='https://chat.example.test', ALICE='@cialice:chat.example.test', BOB='@cibob:chat.example.test';
const COMMAND='exec /usr/bin/turnserver -c /config/turnserver.ci.conf --relay-ip=172.30.239.3 --allowed-peer-ip=172.30.239.3';
const execute=promisify(execFile);
const dockerRead=async args=>(await execute('docker',args,{timeout:10000,maxBuffer:1024*1024,windowsHide:true})).stdout.trim();
const requireProof=value=>{if(!value)throw new Error('The direct-audio CI scope could not be verified.');};

export function proveDirectEndpoint(network,container){
  const media=container?.networks?.['tavern-ci_media'];
  const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  requireProof(network?.Name==='tavern-ci_media'&&network.Driver==='bridge'&&network.Scope==='local'&&network.Internal===true&&network.EnableIPv6===false&&hash(network.Id)&&hash(container?.id)
    &&network.Labels?.['com.docker.compose.project']==='tavern-ci'&&network.Labels?.['com.docker.compose.network']==='media'&&network.IPAM?.Config?.length===1&&network.IPAM.Config[0].Subnet==='172.30.239.0/24'
    &&container?.name==='/tavern-ci-coturn-1'&&container.running===true&&container.image==='coturn/coturn:4.17.2-r0'
    &&JSON.stringify(container.command)===JSON.stringify([COMMAND])&&Object.keys(container.networks||{}).join(',')==='tavern-ci_media'
    &&container.labels?.['com.docker.compose.project']==='tavern-ci'&&container.labels?.['com.docker.compose.service']==='coturn'
    &&(container.ports===null||typeof container.ports==='object'&&!Array.isArray(container.ports)&&Object.keys(container.ports).length===0)
    &&media?.NetworkID===network.Id&&media.IPAddress==='172.30.239.3'&&media.IPPrefixLen===24&&!media.GlobalIPv6Address
    &&network.Containers?.[container.id]?.Name==='tavern-ci-coturn-1'&&network.Containers[container.id].IPv4Address==='172.30.239.3/24');
}

// Observe only an existing, playing remote audio stream. Do not open another
// microphone or alter the call's stream, tracks, mute state or output volume.
export async function receiveSyntheticAudio(){
  if(location.origin!=='https://chat.example.test'||!isSecureContext)return false;
  const candidates=[...document.querySelectorAll('.call-feeds video')].filter(video=>
    video.srcObject instanceof MediaStream&&!video.muted&&!video.paused&&video.volume>0
    &&video.srcObject.getAudioTracks().some(track=>track.readyState==='live'&&track.enabled));
  if(candidates.length!==1)return false;
  const video=candidates[0],stream=video.srcObject,context=new AudioContext();let source;
  try{
    source=context.createMediaStreamSource(stream);const analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);
    let resumeTimer;try{await Promise.race([context.resume(),new Promise(resolve=>{resumeTimer=setTimeout(resolve,2000);})]);}finally{clearTimeout(resumeTimer);}if(context.state!=='running')return false;
    const samples=new Float32Array(analyser.fftSize),until=performance.now()+12000;
    while(performance.now()<until){
      if(!video.isConnected||video.srcObject!==stream||video.muted||video.paused||video.volume<=0)return false;
      analyser.getFloatTimeDomainData(samples);
      if(samples.some(value=>Math.abs(value)>0.0001))return true;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return false;
  }finally{source?.disconnect();await context.close();}
}

export async function directAudioSmoke({alice,bob,aliceSession,bobSession,roomId,origin,api,ready},{docker=dockerRead}={}){
  requireProof(process.env.TAVERN_CI_SMOKE==='true'&&process.env.TAVERN_CI_TLS==='/tmp/tavern-ci-tls'&&origin===ORIGIN&&isCiRoomId(roomId)
    &&aliceSession?.userId===ALICE&&bobSession?.userId===BOB&&aliceSession.admin===false&&bobSession.admin===false
    &&aliceSession.deviceId&&bobSession.deviceId&&alice!==bob&&alice.context()!==bob.context()&&typeof api==='function'&&typeof ready==='function');
  const owners=new Map([[alice,aliceSession],[bob,bobSession]]),changed=new Set(),opened=new Set();
  let stage='isolated-turn',success=false,cleanupFailed=false;
  const expected=page=>({[page===alice?BOB:ALICE]:[roomId]});
  const accountPath=page=>'/_matrix/client/v3/user/'+encodeURIComponent(owners.get(page).userId)+'/account_data/m.direct';
  async function session(page){
    requireProof(new URL(page.url()).origin===ORIGIN);
    const value=await matrixSmokeRequest(()=>api(page,'/api/auth/session')),owner=owners.get(page);
    requireProof(value.status===200&&value.data.userId===owner.userId&&value.data.deviceId===owner.deviceId&&value.data.admin===false);
  }
  async function native(page,path,body,method){await session(page);return matrixSmokeRequest(()=>api(page,path,body,true,false,method));}
  async function scope(page){
    const state=await native(page,'/_matrix/client/v3/rooms/'+encodeURIComponent(roomId)+'/state');requireProof(state.status===200);proveConferenceRoom(roomId,state.data);
    const who=await native(page,'/_matrix/client/v3/account/whoami');requireProof(who.status===200&&who.data.user_id===owners.get(page).userId&&who.data.device_id===owners.get(page).deviceId);
  }
  try{
    const [network,container]=await Promise.all([
      docker(['network','inspect','tavern-ci_media','--format','{{json .}}']),
      docker(['inspect','tavern-ci-coturn-1','--format','{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"command":{{json .Config.Cmd}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"ports":{{json .HostConfig.PortBindings}},"networks":{{json .NetworkSettings.Networks}}}']),
    ]);proveDirectEndpoint(JSON.parse(network),JSON.parse(container));
    for(const page of owners.keys()){
      stage='ordinary-device-scope';await scope(page);
      requireProof(await page.evaluate(inspectSyntheticDevices)==='synthetic');
      requireProof(await page.locator('.call-panel,iframe[title="Tavern encrypted conference"]').count()===0);
      const relay=await native(page,'/_matrix/client/v3/voip/turnServer');
      requireProof(relay.status===200&&JSON.stringify(relay.data.uris)===JSON.stringify(['turn:172.30.239.3:3478?transport=udp','turn:172.30.239.3:3478?transport=tcp']));
      stage='owned-dm-section';const previous=await native(page,accountPath(page));
      requireProof(previous.status===404&&previous.data.errcode==='M_NOT_FOUND'||previous.status===200&&previous.data&&typeof previous.data==='object'&&!Array.isArray(previous.data)&&Object.keys(previous.data).length===0);
      changed.add(page);requireProof((await native(page,accountPath(page),expected(page),'PUT')).status===200);
      await page.reload();await ready(page);await scope(page);
      await expect(page.getByRole('button',{name:'Start voice call',exact:true})).toBeVisible({timeout:30000});
    }
    stage='outgoing-and-incoming';opened.add(alice);opened.add(bob);
    await alice.getByRole('button',{name:'Start voice call',exact:true}).click();
    await expect(bob.getByRole('button',{name:'Answer with audio',exact:true})).toBeVisible({timeout:45000});
    opened.add(bob);await scope(bob);await bob.getByRole('button',{name:'Answer with audio',exact:true}).click();
    stage='bidirectional-relay-rates';
    for(const page of owners.keys()){
      await page.waitForFunction(()=>{
        const rows=[...document.querySelectorAll('.call-connection dl>div')],values=Object.fromEntries(rows.map(row=>[row.querySelector('dt')?.textContent,row.querySelector('dd')?.textContent]));
        return values.Connection==='connected'&&['connected','completed'].includes(values['ICE transport'])&&values['Local route']==='TURN relay'
          &&parseFloat(values['Download media rate'])>0&&parseFloat(values['Upload media rate'])>0;
      },undefined,{timeout:45000});
      await scope(page);
      const enable=page.getByRole('button',{name:'Enable audio',exact:true});if(await enable.isVisible())await enable.click();
    }
    stage='received-audio';requireProof((await Promise.all([...owners.keys()].map(page=>page.evaluate(receiveSyntheticAudio)))).every(Boolean));
    for(const page of owners.keys())await scope(page);
    success=true;
  }catch{throw new Error('Native direct-audio acceptance failed at '+stage+'. Credentials, addresses and audio samples were withheld.');}
  finally{
    for(const page of opened){
      try{
        await session(page);const end=page.locator('.call-panel .call-end');
        if(await end.isVisible())await end.click({timeout:5000});
        await expect(page.locator('.call-panel')).toHaveCount(0,{timeout:10000});
      }catch{cleanupFailed=true;}
    }
    for(const page of changed){
      try{
        await scope(page);const current=await native(page,accountPath(page));
        requireProof(current.status===200&&JSON.stringify(current.data)===JSON.stringify(expected(page)));
        requireProof((await native(page,accountPath(page),{},'PUT')).status===200);
        await page.reload();await ready(page);
      }catch{cleanupFailed=true;}
    }
    if(cleanupFailed&&success)throw new Error('Native direct audio transferred, but call and DM-fixture cleanup was not confirmed.');
  }
  console.log('PASS: two ordinary accounts used production direct-call signaling and TURN, both reported relay media rates, both received synthetic audio in the real remote playback stream, and the owned call/DM fixture was cleaned up.');
}
