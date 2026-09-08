import { ClientEvent, MatrixEventEvent, RoomEvent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
import { ConditionKind, PushRuleActionName, PushRuleKind } from 'matrix-js-sdk/lib/@types/PushRules';
let client:MatrixClient|null=null,ready=false,started=0,focus=false;
const seen=new Set<string>();
const enabled=()=>localStorage.getItem('tavern.notifications')==='enabled';
export function setNotificationFocus(value:boolean){focus=value;}
export function browserNotificationsEnabled(){return enabled()&&typeof Notification!=='undefined'&&Notification.permission==='granted';}
export async function enableBrowserNotifications(){if(typeof Notification==='undefined')throw new Error('This browser does not support desktop notifications.');if(await Notification.requestPermission()!=='granted')throw new Error('Notifications were not allowed. You can change this in browser site settings.');localStorage.setItem('tavern.notifications','enabled');}
export function disableBrowserNotifications(){localStorage.removeItem('tavern.notifications');}
function eventReceived(event:MatrixEvent,room?:unknown,toStart?:boolean,removed?:boolean,data?:{liveEvent?:boolean}){
  const id=event.getId();if(!client||!ready||toStart||removed||data?.liveEvent===false||!id||seen.has(id)||event.getTs()<started||event.getSender()===client.getUserId()||event.isDecryptionFailure()||event.getType()!=='m.room.message')return;
  seen.add(id);if(seen.size>5000)seen.delete(seen.values().next().value!);
  if(!enabled()||focus||typeof Notification==='undefined'||Notification.permission!=='granted'||document.visibilityState==='visible')return;
  if(!client.getPushActionsForEvent(event,true)?.notify)return;
  // Never expose room names, senders or decrypted content on a locked desktop.
  const notice=new Notification('Tavern',{body:'You have a new message.',tag:`tavern:${event.getRoomId()}`,silent:true});
  notice.onclick=()=>{window.focus();notice.close();};
}
const synced=(state:string)=>{if(state==='PREPARED'||state==='SYNCING')ready=true;};
export function initializeNotifications(c:MatrixClient){resetNotifications();client=c;started=Date.now();c.on(ClientEvent.Sync,synced);c.on(RoomEvent.Timeline,eventReceived);c.on(MatrixEventEvent.Decrypted,eventReceived);}
export function resetNotifications(){client?.off(ClientEvent.Sync,synced);client?.off(RoomEvent.Timeline,eventReceived);client?.off(MatrixEventEvent.Decrypted,eventReceived);client=null;ready=false;seen.clear();}
export async function setRoomNotifications(c:MatrixClient,roomId:string,mode:'all'|'mentions'|'mute'){
  const muteId='io.tavern.mute.'+roomId;
  const rules=await c.getPushRules();
  if(rules.global.override?.some(r=>r.rule_id===muteId))await c.deletePushRule('global',PushRuleKind.Override,muteId);
  if(mode==='mute')await c.addPushRule('global',PushRuleKind.Override,muteId,{conditions:[{kind:ConditionKind.EventMatch,key:'room_id',pattern:roomId}],actions:[]});
  else await c.addPushRule('global',PushRuleKind.RoomSpecific,roomId,{actions:mode==='all'?[PushRuleActionName.Notify]:[]});
  c.setPushRules(await c.getPushRules());
}
