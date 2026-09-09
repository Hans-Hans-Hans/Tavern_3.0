import { readPresenceMode } from './presence';
import { notificationEligible, notificationServerForRoom, readNotificationPreferences, resolveNotificationPreference, updateNotificationPreferences, type NotificationPreferences } from './notification-preferences';
import { ClientEvent, MatrixEventEvent, RoomEvent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
import { ConditionKind, PushRuleActionName, PushRuleKind } from 'matrix-js-sdk/lib/@types/PushRules';
let client:MatrixClient|null=null,ready=false,started=0,focus=false;
const seen=new Set<string>();
const enabled=()=>localStorage.getItem('tavern.notifications')==='enabled';
let soundContext: AudioContext | null = null;
export async function playNotificationSound() { soundContext ||= new AudioContext(); if(soundContext.state==='suspended')await soundContext.resume(); const oscillator=soundContext.createOscillator(),gain=soundContext.createGain(),at=soundContext.currentTime; oscillator.type='sine';oscillator.frequency.setValueAtTime(660,at);oscillator.frequency.exponentialRampToValueAtTime(880,at+.09);gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(.08,at+.015);gain.gain.exponentialRampToValueAtTime(.0001,at+.17);oscillator.connect(gain);gain.connect(soundContext.destination);oscillator.start(at);oscillator.stop(at+.18);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();}; }
export function setNotificationFocus(value:boolean){focus=value;}
export function browserNotificationsEnabled(){return enabled()&&typeof Notification!=='undefined'&&Notification.permission==='granted';}
export async function enableBrowserNotifications(){if(typeof Notification==='undefined')throw new Error('This browser does not support desktop notifications.');if(await Notification.requestPermission()!=='granted')throw new Error('Notifications were not allowed. You can change this in browser site settings.');localStorage.setItem('tavern.notifications','enabled');}
export function disableBrowserNotifications(){localStorage.removeItem('tavern.notifications');}
function eventReceived(event:MatrixEvent,room?:unknown,toStart?:boolean,removed?:boolean,data?:{liveEvent?:boolean}){
  const id=event.getId();if(!client||!ready||toStart||removed||data?.liveEvent===false||!id||seen.has(id)||event.getTs()<started||event.getSender()===client.getUserId()||event.isDecryptionFailure()||event.getType()!=='m.room.message')return;
  seen.add(id);if(seen.size>5000)seen.delete(seen.values().next().value!);
  if(focus||document.visibilityState==='visible')return;
  const preferences=readNotificationPreferences(client),content=event.getContent(),me=client.getUserId()!,setting=resolveNotificationPreference(preferences,event.getRoomId(),notificationServerForRoom(client,event.getRoomId()!));
  const mention=content['m.mentions']?.user_ids?.includes(me)||content['m.mentions']?.room===true||String(content.body||'').includes(me);
  if(!notificationEligible(setting,{mention:!!mention,ignored:client.getIgnoredUsers().includes(event.getSender()!),dnd:readPresenceMode(client)==='dnd',own:event.getSender()===me,nativeNotify:client.getPushActionsForEvent(event,true)?.notify===true}))return;
  // Never expose room names, senders or decrypted content on a locked desktop.
  if(browserNotificationsEnabled()){const notice=new Notification('Tavern',{body:'You have a new message.',tag:`tavern:${event.getRoomId()}`,silent:true});notice.onclick=()=>{window.focus();notice.close();};}
  if(setting.sound)void playNotificationSound().catch(()=>{});
}
const synced=(state:string)=>{if(state==='PREPARED'||state==='SYNCING')ready=true;};
export function initializeNotifications(c:MatrixClient){resetNotifications();client=c;started=Date.now();c.on(ClientEvent.Sync,synced);c.on(RoomEvent.Timeline,eventReceived);c.on(MatrixEventEvent.Decrypted,eventReceived);}
export function resetNotifications(){client?.off(ClientEvent.Sync,synced);client?.off(RoomEvent.Timeline,eventReceived);client?.off(MatrixEventEvent.Decrypted,eventReceived);client=null;ready=false;seen.clear();if(soundContext){void soundContext.close().catch(()=>{});soundContext=null;}}
export async function setRoomNotifications(c:MatrixClient,roomId:string,mode:'all'|'mentions'|'mute'){
  await nativeRoomNotifications(c,roomId,mode);
  await updateNotificationPreferences(p=>({...p,rooms:{...p.rooms,[roomId]:{mode:mode==='mute'?'nothing':mode,mutedUntil:0}}}),c);
}
async function nativeRoomNotifications(c:MatrixClient,roomId:string,mode:'all'|'mentions'|'mute'){
  const muteId='io.tavern.mute.'+roomId;
  const rules=await c.getPushRules();
  if(rules.global.override?.some(r=>r.rule_id===muteId))await c.deletePushRule('global',PushRuleKind.Override,muteId);
  if(mode==='mute')await c.addPushRule('global',PushRuleKind.Override,muteId,{conditions:[{kind:ConditionKind.EventMatch,key:'room_id',pattern:roomId}],actions:[]});
  else await c.addPushRule('global',PushRuleKind.RoomSpecific,roomId,{actions:mode==='all'?[PushRuleActionName.Notify]:[]});
  c.setPushRules(await c.getPushRules());
}
export async function synchronizeNotificationRules(preferences:NotificationPreferences,scope:{roomId?:string;serverId?:string}={}){const c=client;if(!c)return;const rooms=c.getRooms().filter(r=>r.getMyMembership()==='join'&&!r.isSpaceRoom()&&(!scope.roomId||r.roomId===scope.roomId)&&(!scope.serverId||notificationServerForRoom(c,r.roomId)===scope.serverId));for(const room of rooms){const setting=resolveNotificationPreference(preferences,room.roomId,notificationServerForRoom(c,room.roomId));await nativeRoomNotifications(c,room.roomId,setting.mode==='nothing'||setting.mutedUntil===-1?'mute':setting.mode);}}
