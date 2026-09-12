// Real Matrix SDK direct calls through the owned CI TURN server. The only
// microphone source is Chromium's verified synthetic capture device.
import { expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { inspectSyntheticDevices, proveConferenceRoom } from './smoke-conference.mjs';
import { matrixSmokeRequest } from './matrix-smoke-request.mjs';
import { isCiRoomId } from './ci-room-id.mjs';

const ORIGIN='https://chat.example.test', ALICE='@cialice:chat.example.test', BOB='@cibob:chat.example.test';
const COMMAND='exec /usr/bin/turnserver -c /config/turnserver.ci.conf --relay-ip=172.30.239.3 --allowed-peer-ip=172.30.239.3';
const execute=promisify(execFile);
const dockerRead=async args=>(await execute('docker',args,{timeout:10000,maxBuffer:1024*1024,windowsHide:true})).stdout.trim();
const requireProof=value=>{if(!value)throw new Error('The direct-audio CI scope could not be verified.');};
export class DirectAudioAcceptanceError extends Error {
  constructor(message, cleanupConfirmed) { super(message); this.name = 'DirectAudioAcceptanceError'; this.cleanupConfirmed = cleanupConfirmed; }
}

export function nativeTurnCredentialMatches(configuration, relay) {
  if(typeof configuration!=='string'||configuration.length>65536||typeof relay?.username!=='string'||relay.username.length>512||typeof relay?.password!=='string'||relay.password.length>128)return false;
  const secrets=configuration.split(/\r?\n/).filter(line=>line.startsWith('static-auth-secret=')).map(line=>line.slice('static-auth-secret='.length));
  if(secrets.length!==1||secrets[0].length<32)return false;
  const expected=Buffer.from(createHmac('sha1',secrets[0]).update(relay.username).digest('base64')),actual=Buffer.from(relay.password);
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}

async function nativeTurnListener() {
  return new Promise(resolve=>{
    const socket=createConnection({host:'172.30.239.3',port:3478});
    const finish=value=>{socket.destroy();resolve(value);};
    socket.setTimeout(3000,()=>finish('timeout'));
    socket.once('connect',()=>finish('connected'));
    socket.once('error',error=>finish(error.code==='ECONNREFUSED'?'refused':'unreachable'));
  });
}

export function directAudioDiagnostic(values){
  const choose=(key,allowed)=>allowed.includes(values?.[key])?values[key]:'unavailable';
  const count=key=>typeof values?.[key]==='string'&&/^(0|[1-9][0-9]{0,3})$/.test(values[key])?Number(values[key]):null;
  const rate=key=>typeof values?.[key]==='string'&&/^(0|[1-9][0-9]{0,5})(\.[0-9])? kbps$/.test(values[key])?Number.parseFloat(values[key]):null;
  const iceErrors=typeof values?.['ICE error codes']==='string'&&/^[3-7][0-9]{2}(, [3-7][0-9]{2}){0,7}$/.test(values['ICE error codes'])?values['ICE error codes'].split(', ').map(Number):[];
  return {connection:choose('Connection',['new','connecting','connected','disconnected','failed','closed']),
    ice:choose('ICE transport',['new','checking','connected','completed','disconnected','failed','closed']),
    gathering:choose('ICE gathering',['new','gathering','complete']),route:choose('Local route',['TURN relay','host','srflx','prflx']),
    local:count('Local ICE candidates'),relay:count('Local relay candidates'),remote:count('Remote ICE candidates'),
    down:rate('Download media rate'),up:rate('Upload media rate'),iceErrors,
    signaling:choose('Signaling',['stable','have-local-offer','have-remote-offer','have-local-pranswer','have-remote-pranswer','closed']),
    localDescription:choose('Local description',['offer','answer','pranswer','rollback','not set']),remoteDescription:choose('Remote description',['offer','answer','pranswer','rollback','not set']),
    gatheredRelay:count('Gathered relay candidates')};
}

// A separate allocation attempt after a failed real call distinguishes missing
// relay availability from the SDK's call state. No media devices are opened.
async function allocationControl({ uris, username, password }) {
  if(location.origin!=='https://chat.example.test'||!isSecureContext||JSON.stringify(uris)!==JSON.stringify(['turn:172.30.239.3:3478?transport=udp','turn:172.30.239.3:3478?transport=tcp']))return {result:'unavailable',codes:[]};
  let peer, timer; const codes=[];
  try {
    peer=new RTCPeerConnection({iceTransportPolicy:'relay',iceServers:[{urls:uris,username,credential:password}]});
    const gathered=new Promise(resolve=>{
      peer.addEventListener('icecandidateerror',event=>{if(Number.isInteger(event.errorCode)&&event.errorCode>=300&&event.errorCode<=799&&codes.length<8&&!codes.includes(event.errorCode))codes.push(event.errorCode);});
      peer.addEventListener('icecandidate',event=>{if(event.candidate?.type==='relay')resolve('relay');else if(!event.candidate)resolve('no-relay');});
      timer=setTimeout(()=>resolve('timeout'),12000);
    });
    peer.createDataChannel('owned-ci-relay-check'); await peer.setLocalDescription(await peer.createOffer());
    return {result:await gathered,codes};
  }catch{return {result:'unavailable',codes};}finally{clearTimeout(timer);peer?.close();}
}

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
  let stage='isolated-turn',success=false,cleanupFailed=false,failure;
  let side='unavailable',scopeCheck='none',devices='unavailable',panels=null,frames=null,panelState='unavailable';
  let listener='unavailable';const credentials=[];
  const cleanupObservations=[];
  const expected=page=>({[page===alice?BOB:ALICE]:[roomId]});
  const accountPath=page=>'/_matrix/client/v3/user/'+encodeURIComponent(owners.get(page).userId)+'/account_data/m.direct';
  async function session(page){
    requireProof(new URL(page.url()).origin===ORIGIN);
    const value=await matrixSmokeRequest(()=>api(page,'/api/auth/session')),owner=owners.get(page);
    requireProof(value.status===200&&value.data.userId===owner.userId&&value.data.deviceId===owner.deviceId&&value.data.admin===false);
  }
  async function native(page,path,body,method){await session(page);return matrixSmokeRequest(()=>api(page,path,body,true,false,method));}
  async function scope(page){
    scopeCheck='native-room-status';
    const state=await native(page,'/_matrix/client/v3/rooms/'+encodeURIComponent(roomId)+'/state');requireProof(state.status===200);
    scopeCheck='native-room-proof';proveConferenceRoom(roomId,state.data);
    scopeCheck='native-device';const who=await native(page,'/_matrix/client/v3/account/whoami');requireProof(who.status===200&&who.data.user_id===owners.get(page).userId&&who.data.device_id===owners.get(page).deviceId);
    scopeCheck='none';
  }
  try{
    const [network,container]=await Promise.all([
      docker(['network','inspect','tavern-ci_media','--format','{{json .}}']),
      docker(['inspect','tavern-ci-coturn-1','--format','{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"command":{{json .Config.Cmd}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"ports":{{json .HostConfig.PortBindings}},"networks":{{json .NetworkSettings.Networks}}}']),
    ]);proveDirectEndpoint(JSON.parse(network),JSON.parse(container));
    listener=await nativeTurnListener();
    const turnConfiguration=await docker(['exec','tavern-ci-coturn-1','cat','/config/turnserver.ci.conf']);
    for(const page of owners.keys()){
      side=page===alice?'caller':'callee';devices='unavailable';panels=null;frames=null;panelState='unavailable';
      stage='ordinary-device-scope';await scope(page);
      stage='synthetic-devices';const inspected=await page.evaluate(inspectSyntheticDevices);
      devices=['synthetic','missing','unlabeled','unexpected','unavailable'].includes(inspected)?inspected:'unavailable';requireProof(devices==='synthetic');
      stage='existing-media';panels=Math.min(10,await page.locator('.call-panel').count());frames=Math.min(10,await page.locator('iframe[title="Tavern encrypted conference"]').count());
      panelState=await page.evaluate(()=>{const panel=document.querySelector('.call-panel');if(!panel)return 'absent';const status=panel.querySelector('header small')?.textContent;return status==='Call ended'?'ended':status==='Incoming call'?'incoming':'active-or-unknown';});
      requireProof(panels===0&&frames===0);
      stage='turn-credentials';const relay=await native(page,'/_matrix/client/v3/voip/turnServer');
      credentials.push({side,matches:relay.status===200&&nativeTurnCredentialMatches(turnConfiguration,relay.data)});
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
  }catch{
    const diagnostics=await Promise.all([...owners.keys()].map(async page=>{
      let timer;
      try{
        const values=await Promise.race([page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('.call-connection dl>div')].map(row=>[row.querySelector('dt')?.textContent,row.querySelector('dd')?.textContent]))),
          new Promise(resolve=>{timer=setTimeout(()=>resolve(null),2500);})]);
        return directAudioDiagnostic(values);
      }catch{return directAudioDiagnostic(null);}finally{clearTimeout(timer);}
    }));
    const controls=stage==='bidirectional-relay-rates'?await Promise.all([...owners.keys()].map(async page=>{
      try{
        const fresh=await native(page,'/_matrix/client/v3/voip/turnServer');requireProof(fresh.status===200);
        const result=await page.evaluate(allocationControl,fresh.data);
        return {result:['relay','no-relay','timeout'].includes(result?.result)?result.result:'unavailable',codes:Array.isArray(result?.codes)?result.codes.filter(code=>Number.isInteger(code)&&code>=300&&code<=799).slice(0,8):[]};
      }catch{return {result:'unavailable',codes:[]};}
    })):[];
    failure = 'Native direct-audio acceptance failed at '+stage+'. Bounded preflight: '+JSON.stringify({side,scopeCheck,devices,panels,frames,panelState,listener,credentials})+'. Bounded connection observations: '+JSON.stringify(diagnostics)+'. Independent allocation controls: '+JSON.stringify(controls)+'. Credentials, addresses and audio samples were withheld.';
  }
  finally{
    for(const page of opened){
      let cleanupStage='session';
      try{
        await session(page);
        // MatrixCall.hangup is synchronous but sends its encrypted event in the
        // background. Require the callee's native hangup before either reload,
        // rather than racing that event with two local UI dismissals.
        cleanupStage='remote-hangup';
        if(page===bob)await page.waitForFunction(()=>{
          const panel=document.querySelector('.call-panel');
          return !panel||panel.querySelector('header small')?.textContent==='Call ended';
        },undefined,{timeout:15000});
        cleanupStage='dismiss-ended-panel';
        const end=page.locator('.call-panel .call-end');
        if(await end.isVisible())await end.click({timeout:5000});
        await expect(page.locator('.call-panel')).toHaveCount(0,{timeout:10000});
      }catch{cleanupFailed=true;cleanupObservations.push({side:page===alice?'caller':'callee',stage:cleanupStage});}
    }
    for(const page of changed){
      let cleanupStage='room-scope';
      try{
        await scope(page);cleanupStage='restore-dm';const current=await native(page,accountPath(page));
        requireProof(current.status===200&&JSON.stringify(current.data)===JSON.stringify(expected(page)));
        requireProof((await native(page,accountPath(page),{},'PUT')).status===200);
        cleanupStage='reload';await page.reload();await ready(page);
        cleanupStage='no-replayed-call';
        await expect(page.locator('.call-panel')).toHaveCount(0,{timeout:10000});
      }catch{cleanupFailed=true;cleanupObservations.push({side:page===alice?'caller':'callee',stage:cleanupStage});}
    }
    if(cleanupFailed){console.error('Direct call cleanup:',cleanupObservations);}
    if(cleanupFailed&&success)throw new Error('Native direct audio transferred, but call and DM-fixture cleanup was not confirmed.');
  }
  if (failure) throw new DirectAudioAcceptanceError(failure, !cleanupFailed);
  console.log('PASS: two ordinary accounts used production direct-call signaling and TURN, both reported relay media rates, both received synthetic audio in the real remote playback stream, and the owned call/DM fixture was cleaned up.');
}
