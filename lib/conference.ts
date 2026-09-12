import { claimMedia, releaseMedia } from './media-session';
import { authenticatedMatrixMediaUrl } from './matrix-media';
import { conferenceHomeserverUrl } from './conference-url';
import { observeConferenceTelemetry, type ConferenceTelemetry } from './conference-telemetry';
import { ClientEvent, EventType, MatrixEventEvent, RoomEvent, RoomStateEvent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
import { ClientWidgetApi, Widget, WidgetDriver, WidgetEventCapability, EventDirection, MatrixCapabilities, OpenIDRequestState,
  type Capability, type IRoomEvent, type IOpenIDUpdate, type SimpleObservable } from 'matrix-widget-api';

const common = [EventType.CallEncryptionKeysPrefix, EventType.Reaction, EventType.RoomRedaction, 'io.element.call.reaction', EventType.RTCDecline, EventType.RTCMembership];
const sendTypes = new Set<string>([...common, EventType.CallNotify, EventType.RTCNotification]);
const receiveTypes = new Set<string>(common);
const stateTypes = new Set<string>([EventType.RoomCreate, EventType.RoomName, EventType.RoomMember, EventType.RoomEncryption, EventType.GroupCallMemberPrefix]);
const deviceTypes = new Set<string>([EventType.CallInvite, EventType.CallCandidates, EventType.CallAnswer, EventType.CallHangup, EventType.CallReject, EventType.CallSelectAnswer, EventType.CallNegotiate, EventType.CallSDPStreamMetadataChanged, EventType.CallSDPStreamMetadataChangedPrefix, EventType.CallReplaces, EventType.CallEncryptionKeysPrefix]);
const raw = (event: MatrixEvent) => ({ ...event.getEffectiveEvent(), room_id: event.getRoomId(), unsigned: event.getUnsigned() }) as IRoomEvent;
export class TavernCallDriver extends WidgetDriver {
  private delayed = new Map<string, string>();
  private ownKeys: Set<string>;
  private stopped = false;
  private closing = false;
  private memberships = new Set<string>();
  private stateWrites = new Map<string, Promise<unknown>>();
  private leaveListeners = new Set<() => void>();
  constructor(private client: MatrixClient, readonly roomId: string) { super(); const me=client.getUserId()!,device=client.getDeviceId()!; this.ownKeys=new Set([me,`_${me}_${device}_m.call`,`${me}_${device}_m.call`]); }
  stop() { this.stopped=true; this.leaveListeners.clear(); }
  beginLeave() { this.closing=true; }
  private leaveChanged() { for(const notify of this.leaveListeners)notify(); }
  waitForLeave(timeout: number) {
    if(!this.memberships.size&&!this.stateWrites.size)return Promise.resolve();
    return new Promise<void>(resolve=>{
      const finish=()=>{clearTimeout(timer);this.leaveListeners.delete(changed);resolve();};
      const changed=()=>{if(!this.memberships.size&&!this.stateWrites.size)finish();};
      const timer=setTimeout(finish,Math.max(0,timeout));this.leaveListeners.add(changed);changed();
    });
  }
  private room(id?: string | null) { if (this.stopped || (id && id!==this.roomId)) throw new Error('Conference access is limited to its active room.'); const room=this.client.getRoom(this.roomId); if (!room || room.getMyMembership()!=='join' || !room.hasEncryptionStateEvent()) throw new Error('Conference room is unavailable or unencrypted.'); return room; }
  private state(type: string, key?: string | null) { this.room(); if(type!==EventType.GroupCallMemberPrefix || key==null || !this.ownKeys.has(key)) throw new Error('Conference may update only this device’s call membership.'); }
  async validateCapabilities(requested: Set<Capability>) {
    const allowed=new Set<string>([MatrixCapabilities.AlwaysOnScreen,MatrixCapabilities.MSC4039DownloadFile,MatrixCapabilities.MSC4157SendDelayedEvent,MatrixCapabilities.MSC4157UpdateDelayedEvent,MatrixCapabilities.MSC4515RtcTransports,`org.matrix.msc2762.timeline:${this.roomId}`]);
    for(const type of sendTypes) allowed.add(WidgetEventCapability.forRoomEvent(EventDirection.Send,type).raw);
    for(const type of receiveTypes) allowed.add(WidgetEventCapability.forRoomEvent(EventDirection.Receive,type).raw);
    for(const type of stateTypes) allowed.add(WidgetEventCapability.forStateEvent(EventDirection.Receive,type).raw);
    for(const key of this.ownKeys) allowed.add(WidgetEventCapability.forStateEvent(EventDirection.Send,EventType.GroupCallMemberPrefix,key).raw);
    for(const type of deviceTypes) for(const direction of [EventDirection.Send,EventDirection.Receive]) allowed.add(WidgetEventCapability.forToDeviceEvent(direction,type).raw);
    return new Set([...requested].filter(cap=>allowed.has(cap)));
  }
  async sendEvent(type:string,content:unknown,stateKey?:string|null,roomId?:string|null) {
    const room=this.room(roomId); let result:{event_id:string};
    if(stateKey!=null){
      this.state(type,stateKey);
      const value=content as any,clear=!!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.keys(value).length===0||(Object.keys(value).length===1&&Array.isArray(value.memberships)&&value.memberships.length===0));
      if(this.closing&&!clear)throw new Error('The conference is leaving.');
      // Keep the final empty state behind already submitted writes for this key.
      // The widget acknowledges hangup before its native leave request finishes.
      const previous=this.stateWrites.get(stateKey)||Promise.resolve();
      const writing=previous.catch(()=>{}).then(async()=>{
        this.state(type,stateKey);
        const sent=await this.client.sendStateEvent(room.roomId,type as any,content as any,stateKey);
        if(clear)this.memberships.delete(stateKey);else this.memberships.add(stateKey);
        return sent;
      });
      this.stateWrites.set(stateKey,writing);
      try{result=await writing;}finally{if(this.stateWrites.get(stateKey)===writing)this.stateWrites.delete(stateKey);this.leaveChanged();}
    }
    else { if(!sendTypes.has(type))throw new Error('Unsupported conference event.');
      if(type===EventType.RoomRedaction){const data=content as any;if(typeof data?.redacts!=='string')throw new Error('Missing redaction target.');const event=room.findEventById(data.redacts);if(!event||event.getSender()!==this.client.getUserId()||!receiveTypes.has(event.getType()))throw new Error('Only your call events can be redacted here.');result=await this.client.redactEvent(room.roomId,data.redacts);}
      else result=await this.client.sendEvent(room.roomId,type as any,content as any);
    }
    return {roomId:room.roomId,eventId:result.event_id};
  }
  async sendDelayedEvent(delay:number,type:string,content:unknown,stateKey?:string|null,roomId?:string|null) {
    this.room(roomId);this.state(type,stateKey);
    if(!Number.isFinite(delay)||delay<0||delay>86400000||!content||Object.keys(content as object).length)throw new Error('Delayed conference events may only clear this device’s membership.');
    if(this.closing)throw new Error('The conference is leaving.');
    const result=await this.client._unstable_sendDelayedStateEvent(this.roomId,{delay},type as any,content as any,stateKey!);this.delayed.set(result.delay_id,stateKey!);return{roomId:this.roomId,delayId:result.delay_id};
  }
  private checkDelay(id:string){this.room();if(!this.delayed.has(id))throw new Error('Unknown conference delayed event.');}
  async cancelScheduledDelayedEvent(id:string){this.checkDelay(id);await this.client._unstable_cancelScheduledDelayedEvent(id);this.delayed.delete(id);}
  async restartScheduledDelayedEvent(id:string){this.checkDelay(id);await this.client._unstable_restartScheduledDelayedEvent(id);}
  async sendScheduledDelayedEvent(id:string){
    this.checkDelay(id);const key=this.delayed.get(id)!,previous=this.stateWrites.get(key)||Promise.resolve();
    const writing=previous.catch(()=>{}).then(async()=>{this.checkDelay(id);await this.client._unstable_sendScheduledDelayedEvent(id);this.delayed.delete(id);this.memberships.delete(key);});
    this.stateWrites.set(key,writing);
    try{await writing;}finally{if(this.stateWrites.get(key)===writing)this.stateWrites.delete(key);this.leaveChanged();}
  }
  async sendToDevice(type:string,encrypted:boolean,map:Record<string,Record<string,object>>) {
    const room=this.room();if(!encrypted||!deviceTypes.has(type))throw new Error('Call device messages must be encrypted.');
    for(const [user,devices] of Object.entries(map)){if(room.getMember(user)?.membership!=='join')throw new Error('Call recipient is not a room member.');for(const [device,content] of Object.entries(devices)){if(!device||device==='*')throw new Error('An exact recipient device is required.');if(type===EventType.CallEncryptionKeysPrefix&&(content as any).room_id!==this.roomId)throw new Error('Call key belongs to another room.');await this.client.encryptAndSendToDevice(type,[{userId:user,deviceId:device}],content);}}
  }
  async readRoomState(roomId:string,type:string,key:string|undefined){const room=this.room(roomId);if(!stateTypes.has(type))throw new Error('Unsupported conference state.');const events=key===undefined?room.currentState.getStateEvents(type):[room.currentState.getStateEvents(type,key)].filter(Boolean);return events.map(e=>raw(e!));}
  async readRoomTimeline(roomId:string,type:string,msgtype:string|undefined,stateKey:string|undefined,limit:number,since:string|undefined){const room=this.room(roomId);if(stateKey!==undefined)return this.readRoomState(roomId,type,stateKey);if(!receiveTypes.has(type))return[];let events=room.getLiveTimeline().getEvents();await Promise.all(events.filter(e=>e.isEncrypted()).map(e=>this.client.decryptEventIfNeeded(e).catch(()=>{})));if(since){const at=events.findIndex(e=>e.getId()===since);if(at>=0)events=events.slice(at+1);}return events.filter(e=>!e.isDecryptionFailure()&&e.getType()===type&&(!msgtype||e.getContent().msgtype===msgtype)).slice(-Math.min(Math.max(limit||100,1),1000)).reverse().map(raw);}
  getKnownRooms(){this.room();return[this.roomId];}
  askOpenID(observer:SimpleObservable<IOpenIDUpdate>){this.room();void this.client.getOpenIdToken().then(token=>{this.room();observer.update({state:OpenIDRequestState.Allowed,token});}).catch(()=>observer.update({state:OpenIDRequestState.Blocked}));}
  async getRtcTransports(){this.room();return{rtc_transports:await this.client._unstable_getRTCTransports()};}
  async downloadFile(mxc:string){this.room();if(!mxc.startsWith('mxc://'))throw new Error('Invalid media URI.');const url=authenticatedMatrixMediaUrl(this.client,mxc);const response=await fetch(url,{headers:{Authorization:`Bearer ${this.client.getAccessToken()}`},credentials:'same-origin',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Media download failed.');return{file:await response.blob()};}
  processError(error:unknown){const e=error as any;return typeof e?.asWidgetApiErrorData==='function'?{matrix_api_error:e.asWidgetApiErrorData()}:undefined;}
}

export type ConferenceDevices = { audio_enabled?: boolean; video_enabled?: boolean };
export type ConferenceControls = (() => Promise<void>) & { setDevices: (devices: ConferenceDevices) => Promise<void>; setDeafened: (deafened: boolean) => Promise<void> };
export async function mountConference(client:MatrixClient,roomId:string,iframe:HTMLIFrameElement,onClose:()=>void,signal?:AbortSignal,onJoined?:()=>void,managedSession=false,onDevices?:(devices:ConferenceDevices)=>void,options:{voiceOnly?:boolean;onTelemetry?:(value:ConferenceTelemetry|null)=>void}={}):Promise<ConferenceControls>{
  signal?.throwIfAborted();if(!managedSession)claimMedia('conference');
  try {
  const room=client.getRoom(roomId);if(!room||!await client.getCrypto()?.isEncryptionEnabledInRoom(roomId))throw new Error('Conferences require an encrypted room.');
  await room.loadMembersIfNeeded();signal?.throwIfAborted();
  if(!room.currentState.maySendStateEvent(EventType.GroupCallMemberPrefix,client.getUserId()!))throw new Error('A room administrator must enable conference membership in channel permissions.');
  const transports=await client._unstable_getRTCTransports();if(!transports.length)throw new Error('Configure the self-hosted MatrixRTC services before joining a conference.');
  signal?.throwIfAborted();
  const homeserver=client.getHomeserverUrl(),widgetId=crypto.randomUUID(),telemetrySession=crypto.randomUUID(),actor=client.getUserId(),deviceId=client.getDeviceId(),params=new URLSearchParams({widgetId,tavernTelemetry:telemetrySession,parentUrl:location.origin,roomId,userId:actor!,deviceId:deviceId!,baseUrl:conferenceHomeserverUrl(homeserver,location.origin),intent:options.voiceOnly?'start_call_voice':'start_call',perParticipantE2EE:'true',allowIceFallback:'false',confineToRoom:'true',theme:'dark',background:'solid',showControls:'true'});
  const url=new URL('/element-call/index.html',location.origin);url.hash='?'+params;
  const driver=new TavernCallDriver(client,roomId),api=new ClientWidgetApi(new Widget({id:widgetId,creatorUserId:client.getUserId()!,type:'m.custom',name:'Tavern conference',url:url.href,waitForIframeLoad:false}),iframe,driver);api.setViewedRoomId(roomId);
  let stopped=false;
  const timeline=(event:MatrixEvent)=>{if(!stopped&&event.getRoomId()===roomId&&!event.isDecryptionFailure()&&receiveTypes.has(event.getType()))void api.feedEvent(raw(event)).catch(()=>{});};
  const state=(event:MatrixEvent)=>{if(!stopped&&event.getRoomId()===roomId&&stateTypes.has(event.getType()))void api.feedStateUpdate(raw(event)).catch(()=>{});};
  const device=(event:MatrixEvent)=>{if(stopped||!event.isEncrypted()||event.isDecryptionFailure()||!deviceTypes.has(event.getType())||room.getMember(event.getSender()!)?.membership!=='join')return;if(event.getType()===EventType.CallEncryptionKeysPrefix&&event.getContent().room_id!==roomId)return;void api.feedToDevice({sender:event.getSender()!,type:event.getType(),content:event.getContent()},true).catch(()=>{});};
  const decrypted=(event:MatrixEvent)=>{if(event.getRoomId())timeline(event);else device(event);};
  client.on(RoomEvent.Timeline,timeline);client.on(RoomStateEvent.Events,state);client.on(ClientEvent.ToDeviceEvent,device);client.on(MatrixEventEvent.Decrypted,decrypted);
  const close=(event:CustomEvent)=>{event.preventDefault();void api.transport.reply(event.detail,{});onClose();};
  for(const action of ['io.element.close','im.vector.hangup'])api.on('action:'+action,close);
  // The panel already retains this iframe while navigating or minimizing.
  // Matrix's widget API delegates this advertised capability to its host.
  api.on('action:set_always_on_screen',(event:CustomEvent)=>{event.preventDefault();api.transport.reply(event.detail,{success:!stopped&&typeof event.detail.data?.value==='boolean'});});
  const devices=(data:any)=>({...(typeof data?.audio_enabled==='boolean'?{audio_enabled:data.audio_enabled}:{}),...(typeof data?.video_enabled==='boolean'?{video_enabled:data.video_enabled}:{})});
  for(const action of ['io.element.join','io.element.device_mute'])api.on('action:'+action,(event:CustomEvent)=>{event.preventDefault();void api.transport.reply(event.detail,{});if(action==='io.element.join')onJoined?.();else onDevices?.(devices(event.detail.data));});
  const stopTelemetry=observeConferenceTelemetry({iframe,widgetId,session:telemetrySession,roomId,isCurrent:()=>!stopped&&!signal?.aborted&&client.getUserId()===actor&&client.getDeviceId()===deviceId&&client.getHomeserverUrl()===homeserver&&client.getRoom(roomId)===room&&room.getMyMembership()==='join',onUpdate:value=>options.onTelemetry?.(value)});
  iframe.src=url.href;
  let closing:Promise<void>|null=null;
  const cleanup=():Promise<void>=>closing??=(async()=>{
    stopped=true;stopTelemetry();driver.beginLeave();
    const deadline=Date.now()+5000;let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([api.transport.send('im.vector.hangup',{}).catch(()=>{}),new Promise<void>(resolve=>{timer=setTimeout(resolve,2500);})]);
      await driver.waitForLeave(deadline-Date.now());
    }finally{
      clearTimeout(timer);driver.stop();api.stop();if(!managedSession)releaseMedia('conference');
      client.off(RoomEvent.Timeline,timeline);client.off(RoomStateEvent.Events,state);client.off(ClientEvent.ToDeviceEvent,device);client.off(MatrixEventEvent.Decrypted,decrypted);
      if(iframe.src===url.href)iframe.src='about:blank';
    }
  })();
  return Object.assign(cleanup,{setDeafened:stopTelemetry.setDeafened,setDevices:async(patch:ConferenceDevices)=>{if(stopped)throw new Error('The conference has ended.');const result=devices(await api.transport.send('io.element.device_mute',patch));if(stopped)return;onDevices?.(result);if(Object.entries(patch).some(([key,value])=>(result as any)[key]!==value))throw new Error('The call is still preparing this device. Check its settings in the conference.');}});
  }catch(error){if(!managedSession)releaseMedia('conference');throw error;}
}
