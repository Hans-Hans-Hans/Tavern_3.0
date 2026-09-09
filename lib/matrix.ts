'use client';
// Matrix is the source of truth. The self-hosted gateway forwards Matrix requests to Synapse.
import { readInstanceConfig } from './instance';
import { HttpApiEvent } from 'matrix-js-sdk/lib/http-api/interface';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { readServerEmoji, serverEmojiHtml } from './server-emoji';
import { indexReactions, type Reaction } from './message-projection';
import { applyPresenceMode } from './presence';
import { initializeAppearance, resetAppearance } from './appearance';
import { initializeOutbox, resetOutbox } from './outbox';
import { initializeSearch, resetSearch, searchMessages } from './search-index';
import { initializeNotifications, resetNotifications } from './notifications';
import { initializeCalls, resetCalls } from './calls';
import { cryptoCallbacks, initializeSecurity, resetSecurity, securityOperationInProgress } from './security';
import { notifyAccountRequirement, requestApi, isManagedAccount, accountSignedOut, type AccountSession } from './api';
let client:MatrixClient|null=null;
let sessionPromise:Promise<boolean>|null=null;
let releaseLock:(()=>void)|null=null;
let sdk:typeof import('matrix-js-sdk');
// Legacy prototype identifiers intentionally remain stable: changing the crypto
// database or Web Lock name can strand keys or permit concurrent store access.
const sessionKey='harbor.matrix.session.v1';
const prefsKey='io.harbor.preferences';
const savedKey='io.harbor.bookmarks';
const workspaceKey='io.harbor.workspace';
const pendingFiles=new Map<string,any>();
const lastReceipts=new Map<string,string>();
const eventCache=new Map<string,MatrixEvent>();
const accountQueues=new Map<string,Promise<any>>();
const safeString=(v:unknown,fallback="")=>typeof v==="string"?v.slice(0,16000):fallback;
const safeStrings=(v:unknown):string[]=>Array.isArray(v)?v.filter(x=>typeof x==="string"):[];
function safePrefs(p:any){return {theme:p?.theme==="dark"?"dark":"light",accent:["gold","blue","violet"].includes(p?.accent)?p.accent:"gold",naming:p?.naming==="legacy"?"legacy":"standard",typing:p?.typing===true,focus:p?.focus===true,compact:p?.compact===true,muted:safeStrings(p?.muted)}}
const watchers=new Set<()=>void>();
let syncState='Not connected';
const notify=()=>watchers.forEach(fn=>fn());
export function onMatrixUpdate(fn:()=>void){watchers.add(fn);return()=>{watchers.delete(fn)}}
export function matrixStatus(){return {connected:!!client,state:syncState,homeserver:client?.getHomeserverUrl(),userId:client?.getUserId(),deviceId:client?.getDeviceId(),crypto:!!client?.getCrypto()}}
export function getMatrixClient(){return client}
export function matrixSessionInProgress(){return !!sessionPromise||!!client||securityOperationInProgress();}
export function threadHasOlder(roomId:string,rootId:string){const timeline=client?.getRoom(roomId)?.getThread(rootId)?.timelineSet.getLiveTimeline();return !!timeline?.getPaginationToken(sdk.Direction.Backward);}
export async function loadThreadHistory(roomId:string,rootId:string){const c=requireClient(),room=roomRequired(roomId);if(!room.getThread(rootId))await getRoomMessages(room,rootId);const timeline=room.getThread(rootId)?.timelineSet.getLiveTimeline();if(!timeline)throw new Error('This thread history is unavailable. Reopen the thread and try again.');await c.paginateEventTimeline(timeline,{backwards:true,limit:50});notify();}
function baseUrl(value:string){const u=new URL(value);if(u.protocol!=='https:')throw new Error('Use an HTTPS homeserver address.');if(u.username||u.password||u.search||u.hash)throw new Error('Enter only the HTTPS homeserver address.');return u.href.replace(/\/$/,'')}
async function attachSession(s:any){
 sdk??=await import('matrix-js-sdk');
 if(client)return true;
 if(!navigator.locks)throw new Error('Your browser needs Web Locks support to safely use encrypted messaging. Try a current Chrome, Edge, or Firefox.');
 let unlock!:()=>void;
 const held=new Promise<void>(r=>unlock=r);
 await new Promise<void>((resolve,reject)=>{navigator.locks.request('harbor-matrix-'+s.userId+'-'+s.deviceId,{ifAvailable:true},async lock=>{if(!lock){reject(new Error('This Matrix session is already open in another tab. Use that tab to protect your encryption keys.'));return;}releaseLock=unlock;resolve();await held;}).catch(reject)});
 const c=sdk.createClient({baseUrl:baseUrl(s.baseUrl),accessToken:s.accessToken,userId:s.userId,deviceId:s.deviceId,timelineSupport:true,verificationMethods:['m.sas.v1'],cryptoCallbacks:cryptoCallbacks(()=>c),forceTURN:true,fallbackICEServerAllowed:false,...(s.managed?{fetchFn:((url:any,options:any)=>{const target=new URL(String(url),location.origin);if(target.origin!==location.origin)throw new Error('Account requests must stay on this Tavern instance.');return fetch(url,{...options,credentials:'same-origin'}).then(async response=>{if(response.status===403)notifyAccountRequirement(await response.clone().json().catch(()=>null));return response;});}) as typeof fetch}:{})});
 try{
  syncState='Initializing encryption';notify();
  await c.initRustCrypto({cryptoDatabasePrefix:'harbor-crypto-'+s.userId+'-'+s.deviceId});
  client=c;c.on(HttpApiEvent.SessionLoggedOut,()=>{clearLocalMatrixSession();if(s.managed)accountSignedOut();});initializeSecurity(c);initializeCalls(c);initializeNotifications(c);
  c.on(sdk.ClientEvent.Sync,state=>{syncState=state==='PREPARED'||state==='SYNCING'?'Connected':state==='ERROR'?'Reconnecting':state;notify()});
  c.on(sdk.RoomEvent.Timeline,notify);c.on(sdk.RoomEvent.Receipt,notify);c.on(sdk.RoomEvent.MyMembership,notify);c.on(sdk.MatrixEventEvent.Decrypted,notify);c.on(sdk.RoomEvent.LocalEchoUpdated,notify);c.on(sdk.RoomMemberEvent.Typing,notify);c.on(sdk.RoomStateEvent.Events,notify);c.on(sdk.RoomMemberEvent.Name,notify);c.on(sdk.UserEvent.Presence,notify);c.on(sdk.ClientEvent.AccountData,notify);
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{c.off(sdk.ClientEvent.Sync,onSync);reject(new Error('The homeserver did not complete the initial sync. Please reconnect.'))},45000);const onSync=(state:string,_prev?:string|null,data?:any)=>{if(state==='ERROR'&&data?.error?.errcode==='M_UNKNOWN_TOKEN'){clearTimeout(timeout);c.off(sdk.ClientEvent.Sync,onSync);reject(data.error);}if(state==='PREPARED'){clearTimeout(timeout);c.off(sdk.ClientEvent.Sync,onSync);resolve()}};c.on(sdk.ClientEvent.Sync,onSync);c.startClient({initialSyncLimit:60,lazyLoadMembers:true,threadSupport:true,pollTimeout:30000}).catch(e=>{clearTimeout(timeout);c.off(sdk.ClientEvent.Sync,onSync);reject(e)})});
  await applyPresenceMode(c).catch(()=>{});
  initializeAppearance(c);void initializeOutbox(c,item=>matrixApi('send',{conversation:item.roomId,parent:item.parent,serverId:item.serverId,body:item.body,nonce:item.id})).catch(error=>console.warn('Local outbox unavailable:',error.message));
  void initializeSearch(c).catch(error=>console.warn('Local search unavailable:',error.message));
  return true;
 }catch(e){resetOutbox();resetAppearance();resetSearch();resetNotifications();resetCalls();resetSecurity();c.stopClient();client=null;syncState='Not connected';releaseLock?.();releaseLock=null;throw e}
}
export async function restoreMatrixSession(){if(client)return true;if(sessionPromise)return sessionPromise;const raw=sessionStorage.getItem(sessionKey);if(!raw)return false;sessionPromise=(async()=>{try{return await attachSession(JSON.parse(raw))}catch(e){if((e as any)?.errcode==='M_UNKNOWN_TOKEN')sessionStorage.removeItem(sessionKey);throw e}finally{sessionPromise=null}})();return sessionPromise}
export async function attachManagedMatrixSession(s:AccountSession){if(client)return true;if(sessionPromise)return sessionPromise;const url=new URL(s.baseUrl,location.origin);if(url.origin!==location.origin)throw new Error('Invalid account gateway.');sessionPromise=attachSession({...s,baseUrl:url.href,accessToken:'cookie-session:'+s.deviceId,managed:true});try{return await sessionPromise}finally{sessionPromise=null}}
export async function connectMatrix(server:string,user:string,password:string,onStatus:(s:string)=>void){
 if(sessionPromise)throw new Error('A connection is already in progress. Please wait.');
 if(sessionStorage.getItem(sessionKey)){onStatus('Reconnecting your existing encrypted session…');await restoreMatrixSession();return;}
 sessionPromise=performConnect(server,user,password,onStatus).then(()=>true);try{await sessionPromise}finally{sessionPromise=null}
}
async function performConnect(server:string,user:string,password:string,onStatus:(s:string)=>void){
 if(client)throw new Error('Sign out of the current Matrix account first.');
 sdk??=await import('matrix-js-sdk');const base=baseUrl(server);onStatus('Checking your homeserver…');
 const auth=sdk.createClient({baseUrl:base});const flows=await auth.loginFlows();if(!flows.flows.some(f=>f.type==='m.login.password'))throw new Error('This homeserver does not support password sign-in. SSO-only servers are not supported in this first release.');
 onStatus('Signing in securely…');const result=await auth.loginRequest({type:'m.login.password',identifier:{type:'m.id.user',user:user.trim()},password,initial_device_display_name:'Tavern browser'});
 const s={baseUrl:base,accessToken:result.access_token,userId:result.user_id,deviceId:result.device_id};
 onStatus('Preparing encryption and syncing your rooms…');try{await attachSession(s);sessionStorage.setItem(sessionKey,JSON.stringify(s))}catch(e){const cleanup=sdk.createClient({baseUrl:base,accessToken:s.accessToken});await cleanup.logout().catch(()=>{});throw e}notify();
}
export function clearLocalMatrixSession(){const c=client;resetOutbox();resetAppearance();resetSearch();resetNotifications();resetCalls();resetSecurity();c?.stopClient();c?.removeAllListeners();client=null;sessionStorage.removeItem(sessionKey);sessionPromise=null;pendingFiles.clear();eventCache.clear();lastReceipts.clear();accountQueues.clear();releaseLock?.();releaseLock=null;syncState='Not connected';notify()}
export async function disconnectMatrix(){if(securityOperationInProgress())throw new Error('Wait for the encryption operation to finish before signing out.');if(sessionPromise)throw new Error('Wait for the current connection attempt to finish.');if(isManagedAccount())await requestApi('/auth/logout',{});else if(client)await client.logout();clearLocalMatrixSession();if(isManagedAccount())accountSignedOut()}
function requireClient(){if(!client)throw new Error('Connect your Matrix homeserver to start messaging.');return client}
const writeAccount=(key:string,value:any)=>(requireClient() as any).setAccountData(key,value);
const account=(key:string)=>client?.getAccountData(key as any)?.getContent()||{};
function mutateAccount(key:string,mutate:(old:any)=>any){const task=(accountQueues.get(key)||Promise.resolve()).catch(()=>{}).then(()=>writeAccount(key,mutate(account(key))));accountQueues.set(key,task);return task;}
const savedEvents=()=>Array.isArray(account(savedKey).events)?account(savedKey).events.filter((x:any)=>typeof x?.id==='string'&&typeof x?.roomId==='string').slice(0,500):[];
function allEvents(room:Room){return [...new Map([...room.getLiveTimeline().getEvents(),...room.getThreads().flatMap(t=>t.events)].map(e=>[e.getId(),e])).values()];}
const joined=()=>client?.getRooms().filter(r=>r.getMyMembership()==='join'&&!r.isSpaceRoom())||[];
function roomRequired(id:string){const r=requireClient().getRoom(id);if(!r||r.getMyMembership()!=='join')throw new Error('Join this conversation before opening it.');return r}
function directIds(){return new Set(Object.values(account('m.direct')).flatMap(safeStrings))}
function normalize(room:Room,event:MatrixEvent,context?:{reactions:Map<string,Reaction[]>;pinned:Set<string>;saved:Set<string>}){
 const c=event.getContent()||{},me=client?.getUserId(),id=event.getId()!,sender=event.getSender()!;
 const raw=event.getOriginalContent()||{};eventCache.set(id,event);if(eventCache.size>5000)eventCache.delete(eventCache.keys().next().value!);
 const reactions=(context?.reactions||indexReactions(allEvents(room),me)).get(id)||[];
 const pinned=context?.pinned||new Set(safeStrings(room.currentState.getStateEvents('m.room.pinned_events','')?.getContent().pinned));
 const thread=room.getThread(id);
 const encrypted=event.isEncrypted();
 const file=c.file&&typeof c.file==='object'&&typeof c.file.url==='string'?c.file:null;
 return {id,forum:c['io.tavern.forum']&&typeof c['io.tavern.forum']==='object'?{title:safeString(c['io.tavern.forum'].title).slice(0,120),tags:safeStrings(c['io.tavern.forum'].tags).slice(0,10)}:null,lastActivity:thread?.events.at(-1)?.getTs()||event.getTs(),body:event.isDecryptionFailure()?'🔒 Unable to decrypt on this device. Import your encryption keys in Privacy settings.':safeString(c.body,'[Unsupported message]'),author_id:sender,author_name:safeString(room.getMember(sender)?.name,sender),conversation_id:room.roomId,conversation_name:safeString(room.name,room.roomId),created_at:event.getTs(),edited_at:event.replacingEventDate()?.getTime()||null,parent_id:raw['m.relates_to']?.rel_type==='m.thread'?raw['m.relates_to'].event_id||null:null,pinned:Number(pinned.has(id)),saved:Number(context?context.saved.has(id):savedEvents().some((x:any)=>x.id===id)),replies:thread?.length||0,reactions,attachments:['m.file','m.image','m.video','m.audio'].includes(c.msgtype||'')&&(c.url||file?.url)?[{id,name:safeString(c.filename,safeString(c.body,'Attachment')),size:typeof c.info?.size==='number'?c.info.size:0,url:safeString(c.url,file?.url),file,encrypted,type:safeString(c.info?.mimetype),width:Number(c.info?.w)||undefined,height:Number(c.info?.h)||undefined,thumbnail:c.info?.thumbnail_file?.url||c.info?.thumbnail_url?{url:safeString(c.info?.thumbnail_file?.url,c.info?.thumbnail_url),file:c.info?.thumbnail_file||null,type:safeString(c.info?.thumbnail_info?.mimetype)}:null}]:[],encrypted,sending:!!event.status};
}
async function getRoomMessages(room:Room,parent?:string,includeThreads=false){
 let events=includeThreads?allEvents(room):room.getLiveTimeline().getEvents();
 if(parent){let t=room.getThread(parent);if(!t){const root=room.findEventById(parent);if(root)t=room.createThread(parent,root,[],true);}if(t){if(t.events.length<2)await requireClient().getLatestTimeline(t.timelineSet);events=t.events;}else{const r=await requireClient().relations(room.roomId,parent,'m.thread','m.room.message',{limit:100});events=r.events;}}
 await Promise.all(events.filter(e=>e.isEncrypted()).map(e=>requireClient().decryptEventIfNeeded(e).catch(()=>{})));
 const context={reactions:indexReactions(allEvents(room),client?.getUserId()),pinned:new Set(safeStrings(room.currentState.getStateEvents('m.room.pinned_events','')?.getContent().pinned)),saved:new Set<string>(savedEvents().map((e:any)=>e.id))};
 return events.filter(e=>(e.getType()==='m.room.message'||e.isDecryptionFailure())&&!e.isRedacted()&&e.getContent()['m.relates_to']?.rel_type!=='m.replace').map(e=>normalize(room,e,context)).filter(m=>parent?m.parent_id===parent:includeThreads||!m.parent_id);
}
export async function matrixApi(action:string,p?:any,params:Record<string,string>={}):Promise<any>{
 if(action==='bootstrap'){
  if(!client){let preferences={};try{preferences=JSON.parse(localStorage.getItem('harbor.appearance')||'{}')}catch{}return {me:{id:'preview',name:'You',role:'member'},workspace:{name:'Tavern'},members:[{id:'preview',name:'You',role:'member'}],conversations:[],memberships:[],preferences:safePrefs(preferences),preview:true,servers:[],invitations:[]}}
  const c=client,me=c.getUserId()!,rooms=joined(),dms=directIds(),members=new Map<string,any>(),memberships:any[]=[];
  for(const r of rooms)for(const m of r.getJoinedMembers()){members.set(m.userId,{id:m.userId,name:safeString(m.name,m.userId),role:'member'});memberships.push({conversation_id:r.roomId,user_id:m.userId});}
  const profile=c.getUser(me);members.set(me,{id:me,name:safeString(profile?.displayName,me),role:'member'});
  return {me:{...members.get(me),email:me},workspace:{name:safeString(account(workspaceKey).name,new URL(c.getHomeserverUrl()).hostname)},members:[...members.values()],memberships,conversations:rooms.map(r=>({id:r.roomId,name:safeString(r.name,r.roomId),description:safeString(r.currentState.getStateEvents('m.room.topic','')?.getContent().topic,'A place for your conversations.'),kind:dms.has(r.roomId)?'dm':'channel',unread:r.getUnreadNotificationCount()||0,encrypted:r.hasEncryptionStateEvent(),private:r.getJoinRule()!=='public'})),servers:c.getRooms().filter(r=>r.isSpaceRoom()&&r.getMyMembership()==='join').map(r=>({id:r.roomId,name:safeString(r.name,r.roomId),roomIds:r.currentState.getStateEvents('m.space.child').filter(e=>safeStrings(e.getContent().via).length>0).map(e=>e.getStateKey()!)})),preferences:safePrefs(account(prefsKey)),invitations:c.getRooms().filter(r=>r.getMyMembership()==='invite').map(r=>({id:r.roomId,name:safeString(r.name,r.roomId)})),preview:false};
 }
 if(action==='preferences'){p=safePrefs(p);localStorage.setItem('harbor.appearance',JSON.stringify(p));if(client)await writeAccount(prefsKey,p);return {preferences:p}}
 if(!client&&['messages','search','saved','threads','mentions','files'].includes(action))return {messages:[],hasMore:false};
 const c=requireClient(),me=c.getUserId()!;
 if(action==='search'){const result=await searchMessages(params.q||'',{cursor:params.cursor});return {...result,messages:result.hits.map(m=>({id:m.id,body:m.body,author_id:m.authorId,author_name:m.authorName,conversation_id:m.roomId,conversation_name:m.roomName,created_at:m.timestamp,parent_id:null,replies:0,reactions:[],attachments:[]}))};}
 if(['messages','search','saved','threads','mentions','files'].includes(action)){
  const rooms=params.conversation?[roomRequired(params.conversation)]:joined();
  if(params.before)await c.scrollback(rooms[0],100);
  let all=(await Promise.all(rooms.map(r=>getRoomMessages(r,params.parent,action!=='messages'&&action!=='threads')))).flat();
  if(action==='saved'){all=[];const saved=savedEvents();for(let i=0;i<saved.length;i+=8){const batch=await Promise.all(saved.slice(i,i+8).map((m:any)=>resolveMatrixMessage(m.roomId,m.id).catch(()=>null)));all.push(...batch.filter(Boolean));}}
  if(action==='search'){const q=params.q.toLocaleLowerCase();all=all.filter(m=>m.body.toLocaleLowerCase().includes(q));}
  if(action==='saved')all=all.filter(m=>m.saved);
  if(action==='threads')all=all.filter(m=>m.replies>0);
  if(action==='files')all=all.filter(m=>m.attachments.length>0);
  if(action==='mentions')all=all.filter(m=>{const e=c.getRoom(m.conversation_id)?.findEventById(m.id);const mentions=e?.getContent()['m.mentions'];return mentions?.user_ids?.includes(me)||mentions?.room||m.body.includes(me)});
  all.sort((a,b)=>action==='messages'?a.created_at-b.created_at:b.created_at-a.created_at);
  return {messages:all,hasMore:action==='messages'&&!!rooms[0]?.getLiveTimeline().getPaginationToken(sdk.Direction.Backward)};
 }
 if(action==='read'){const room=roomRequired(p.conversation);const event=p.id?room.findEventById(p.id):null;if(event&&!event.status&&lastReceipts.get(room.roomId)!==p.id){lastReceipts.set(room.roomId,p.id);try{await c.sendReadReceipt(event,sdk.ReceiptType.ReadPrivate)}catch(e){lastReceipts.delete(room.roomId);throw e}}return {ok:true}}
 if(action==='send'){
  const room=roomRequired(p.conversation);if(p.parent){const root=room.findEventById(p.parent);if(root&&root.getRoomId()!==room.roomId)throw new Error('Thread belongs to another room.');}
  const content:any={msgtype:'m.text',body:p.body,'m.mentions':{user_ids:p.suppressMentions?[]:room.getJoinedMembers().filter(m=>p.body.includes('@'+m.name)||p.body.includes(m.userId)).map(m=>m.userId)}};
  const formatted=serverEmojiHtml(p.body,readServerEmoji(p.serverId));if(formatted){content.format='org.matrix.custom.html';content.formatted_body=formatted;}
  if(p.forum){content['io.tavern.forum']={title:safeString(p.forum.title).slice(0,120),tags:safeStrings(p.forum.tags).slice(0,10).map(t=>t.slice(0,32))};}
  if(!p.suppressMentions&&p.body.includes('@everyone'))content['m.mentions'].room=true;
  const attachments=(p.attachments||[]).map((id:string)=>{const f=pendingFiles.get(id);if(!f||f.roomId!==room.roomId)throw new Error('Reattach this file before sending.');return f});
  if(attachments.length){for(let i=0;i<attachments.length;i++){const f=attachments[i];const fc={msgtype:f.type.startsWith('image/')?'m.image':f.type.startsWith('video/')?'m.video':f.type.startsWith('audio/')?'m.audio':'m.file',body:f.name,filename:f.name,info:{size:f.size,mimetype:f.type,...f.info},...(f.file?{file:f.file}:{url:f.url})};if(p.parent)await c.sendMessage(room.roomId,p.parent,fc as any,p.nonce+'-f'+i);else await c.sendMessage(room.roomId,fc as any,p.nonce+'-f'+i);} }
  if(p.body.trim()){if(p.parent)await c.sendMessage(room.roomId,p.parent,content,p.nonce);else await c.sendMessage(room.roomId,content,p.nonce);}
  for(const id of p.attachments||[])pendingFiles.delete(id);notify();return {ok:true};
 }
 if(['react','save','pin','edit','delete'].includes(action)){
  const room=joined().find(r=>r.findEventById(p.id)||r.getThreads().some(t=>t.findEventById(p.id))||eventCache.get(p.id)?.getRoomId()===r.roomId);
  if(!room)throw new Error('Load this message before changing it.');const e=room.findEventById(p.id)||room.getThreads().map(t=>t.findEventById(p.id)).find(Boolean)||eventCache.get(p.id)!;
  if(action==='react'){
   const old=allEvents(room).find(e=>e.getType()==='m.reaction'&&!e.isRedacted()&&e.getSender()===me&&e.getContent()['m.relates_to']?.event_id===p.id&&e.getContent()['m.relates_to']?.key===p.emoji);
   if(old)await c.redactEvent(room.roomId,old.getId()!);else await c.sendEvent(room.roomId,'m.reaction' as any,{'m.relates_to':{rel_type:'m.annotation',event_id:p.id,key:p.emoji}});
  }
  if(action==='save'){await mutateAccount(savedKey,old=>{const saved=Array.isArray(old.events)?old.events:[];if(saved.length>=500&&!saved.some((x:any)=>x.id===p.id))throw new Error('Your saved list is full. Remove a bookmark first.');return {events:saved.some((x:any)=>x.id===p.id)?saved.filter((x:any)=>x.id!==p.id):[...saved,{id:p.id,roomId:room.roomId}]}});}
  if(action==='pin'){const old=room.currentState.getStateEvents('m.room.pinned_events','')?.getContent().pinned||[];await c.sendStateEvent(room.roomId,'m.room.pinned_events' as any,{pinned:old.includes(p.id)?old.filter((id:string)=>id!==p.id):[...old,p.id]},'')}
  if(action==='delete'||action==='edit'){if(action==='edit'&&e.getSender()!==me)throw new Error('You can only edit your own messages.');if(action==='delete'&&e.getSender()!==me&&!room.currentState.hasSufficientPowerLevelFor('redact',room.getMember(me)?.powerLevel||0))throw new Error('You cannot remove this message.');if(action==='delete')await c.redactEvent(room.roomId,p.id);else await c.sendEvent(room.roomId,'m.room.message' as any,{msgtype:'m.text',body:'* '+p.body,'m.new_content':{msgtype:'m.text',body:p.body},'m.relates_to':{rel_type:'m.replace',event_id:p.id}});}
  notify();return {ok:true};
 }
 if(action==='createServer'){
  const name=safeString(p.name).trim().slice(0,60);if(!name)throw new Error('A server name is required.');
  const r=await c.createRoom({name,topic:safeString(p.description).slice(0,200),visibility:sdk.Visibility.Private,preset:sdk.Preset.PrivateChat,creation_content:{type:'m.space','m.federate':false}});
  await c.joinRoom(r.room_id);notify();return {id:r.room_id};
 }
 if(action==='roomSettings'){
  const r=roomRequired(p.conversation),name=safeString(p.name).trim().slice(0,60);if(!name)throw new Error('A name is required.');
  await c.sendStateEvent(r.roomId,'m.room.name' as any,{name},'');
  try{await c.sendStateEvent(r.roomId,'m.room.topic' as any,{topic:safeString(p.topic).slice(0,500)},'')}catch{throw new Error('Name saved, but the topic could not be updated. Reopen this panel and retry.');}
  notify();return {ok:true};
 }
 if(action==='moderate'){
  const r=roomRequired(p.conversation);if(p.userId===me)throw new Error('Use another account to change your own role.');
  if(!r.getMember(p.userId))throw new Error('That member is not known in this conversation.');
  const reason=safeString(p.reason).slice(0,200);
  if(p.operation==='kick')await c.kick(r.roomId,p.userId,reason);
  else if(p.operation==='ban')await c.ban(r.roomId,p.userId,reason);
  else if(p.operation==='unban')await c.unban(r.roomId,p.userId);
  else if(p.operation==='moderator'||p.operation==='member')await c.setPowerLevel(r.roomId,p.userId,p.operation==='moderator'?50:0);
  else throw new Error('Unsupported moderation operation.');
  notify();return {ok:true};
 }
 if(action==='create'){
  const direct=p.kind==='dm',invite=safeStrings(p.members).filter(id=>id!==me);
  const parent=!direct&&p.serverId?roomRequired(p.serverId):null;
  if(parent&&(!parent.isSpaceRoom()||!parent.currentState.maySendStateEvent('m.space.child',me)))throw new Error('You cannot add channels to this server.');
  const via=[me.slice(me.indexOf(':')+1)];
  if(direct&&!p.group&&invite.length<=1){const dm=Object.entries(account('m.direct')).find(([peer])=>peer===(invite[0]||me));const existing=(dm?.[1] as string[]|undefined)?.find(id=>c.getRoom(id)?.getMyMembership()==='join');if(existing)return {id:existing};}
  const r=await c.createRoom({name:direct?(p.group?safeString(p.name).slice(0,60):invite.length?undefined:'Notes to self'):p.name,topic:p.description||undefined,visibility:sdk.Visibility.Private,preset:sdk.Preset.PrivateChat,power_level_content_override:{events:{'org.matrix.msc3401.call.member':0,...((await readInstanceConfig()).serverRolePolicy?{'io.tavern.thread':0}:{})}},is_direct:direct,invite,creation_content:{'m.federate':false},initial_state:[...(parent?[{type:'m.space.parent',state_key:parent.roomId,content:{via,canonical:true}}]:[]),{type:'m.room.encryption',state_key:'',content:{algorithm:'m.megolm.v1.aes-sha2'}},{type:'m.room.history_visibility',state_key:'',content:{history_visibility:'joined'}}]});
  if(direct){await mutateAccount('m.direct',map=>{const next={...map};for(const peer of invite.length?invite:[me])next[peer]=[...safeStrings(next[peer]),r.room_id];return next;});}
  if(parent){try{await c.sendStateEvent(parent.roomId,'m.space.child' as any,{via},r.room_id)}catch{await c.joinRoom(r.room_id);notify();throw new Error('Channel created, but adding it to the server failed. It is available in All conversations.');}}
  // /sync supplies authoritative state; joinRoom makes the new room locally available.
  await c.joinRoom(r.room_id);notify();return {id:r.room_id};
 }
 if(action==='profile'){await c.setDisplayName(p.name);notify();return {ok:true}}
 if(action==='workspace'){await writeAccount(workspaceKey,{name:p.name});notify();return {ok:true}}
 if(action==='invite'){if(!/^@[^\s:]+:[^\s]+$/.test(p.email))throw new Error('Use a full Matrix ID, such as @alex:chat.example.com.');await c.invite(p.conversation,p.email);return {ok:true}}
 if(action==='join'){await c.joinRoom(p.id);notify();return {id:p.id}}
 if(action==='decline'){await c.leave(p.id);notify();return {ok:true}}
 throw new Error('That action is not available.');
}
export async function uploadMatrixFile(file:File,roomId:string,options:{signal?:AbortSignal;onProgress?:(loaded:number,total:number)=>void}={}){
 const c=requireClient(),room=roomRequired(roomId);if(file.size>10*1024*1024)throw new Error('Files can be up to 10 MB.');if(!file.size)throw new Error('This file is empty.');
 options.signal?.throwIfAborted();
 let descriptor:any=null,data:Blob=file;
 if(room.hasEncryptionStateEvent()){const {encryptAttachment}=await import('matrix-encrypt-attachment');const encrypted=await encryptAttachment(await file.arrayBuffer());descriptor=encrypted.info;data=new Blob([encrypted.data],{type:'application/octet-stream'});}
 options.signal?.throwIfAborted();const abortController=new AbortController(),abort=()=>abortController.abort();options.signal?.addEventListener('abort',abort,{once:true});
 let uploaded;try{uploaded=await c.uploadContent(data,{includeFilename:false,type:descriptor?'application/octet-stream':file.type||'application/octet-stream',abortController,progressHandler:p=>options.onProgress?.(p.loaded,p.total||data.size)});}finally{options.signal?.removeEventListener('abort',abort);}
 options.signal?.throwIfAborted();if(client!==c)throw new Error('Your account changed during upload. Sign in and attach the file again.');
 const info:any={};
 const {createImagePreview}=await import('./media-processing');const preview=await createImagePreview(file,options.signal);
 if(preview){info.w=preview.sourceWidth;info.h=preview.sourceHeight;try{
  let thumbnailData=preview.blob,thumbnailFile:any=null;
  if(descriptor){const {encryptAttachment}=await import('matrix-encrypt-attachment');const encrypted=await encryptAttachment(await preview.blob.arrayBuffer());thumbnailData=new Blob([encrypted.data],{type:'application/octet-stream'});thumbnailFile=encrypted.info;}
  options.signal?.throwIfAborted();const thumbAbort=new AbortController(),cancelThumb=()=>thumbAbort.abort();options.signal?.addEventListener('abort',cancelThumb,{once:true});let result;
  try{result=await c.uploadContent(thumbnailData,{includeFilename:false,type:thumbnailData.type,abortController:thumbAbort});}finally{options.signal?.removeEventListener('abort',cancelThumb);}
  if(thumbnailFile)info.thumbnail_file={...thumbnailFile,url:result.content_uri};else info.thumbnail_url=result.content_uri;
  info.thumbnail_info={w:preview.width,h:preview.height,size:preview.blob.size,mimetype:preview.blob.type};
 }catch(error){if(options.signal?.aborted)throw error;}}
 options.signal?.throwIfAborted();if(client!==c)throw new Error('Your account changed during upload. Sign in and attach the file again.');
 const id=crypto.randomUUID(),record={id,name:file.name,size:file.size,type:file.type,roomId,info,url:uploaded.content_uri,file:descriptor?{...descriptor,url:uploaded.content_uri}:null};pendingFiles.set(id,record);return record;
}
export function discardMatrixFile(id:string){pendingFiles.delete(id);}
export async function matrixFileBlob(a:any,signal?:AbortSignal,maxBytes=20*1024*1024){
 const c=requireClient();const url=c.mxcUrlToHttp(a.url,undefined,undefined,undefined,false,true,true);if(!url)throw new Error('Invalid Matrix file address.');
 const res=await fetch(url,{headers:{Authorization:'Bearer '+c.getAccessToken()},credentials:'same-origin',referrerPolicy:'no-referrer',signal});if(!res.ok)throw new Error('Could not download this attachment.');
 if(Number(res.headers.get('Content-Length'))>maxBytes)throw new Error('This attachment is too large to preview safely.');
 const reader=res.body?.getReader();if(!reader)throw new Error('This browser cannot stream attachments.');const chunks:Uint8Array[]= [];let size=0;
 try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maxBytes){await reader.cancel();throw new Error('This attachment is too large to preview safely.');}chunks.push(next.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}let payload=bytes.buffer;if(a.file){const {decryptAttachment}=await import('matrix-encrypt-attachment');payload=await decryptAttachment(bytes.buffer,a.file);}
 if(payload.byteLength>maxBytes)throw new Error('This attachment is too large to preview safely.');
 const mime=typeof a.type==='string'&&/^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|ogg)|audio\/(mpeg|mp4|ogg|webm|wav|flac))$/.test(a.type)?a.type:'application/octet-stream';
 return new Blob([payload],{type:mime});
}
export async function downloadMatrixFile(a:any){downloadBlob(await matrixFileBlob(a),a.name)}
function downloadBlob(blob:Blob,name:string){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000)}
export async function exportMatrixMessages(){const c=requireClient();const messages=(await Promise.all(joined().map(r=>getRoomMessages(r)))).flat().filter(m=>m.author_id===c.getUserId());downloadBlob(new Blob([JSON.stringify({exportedAt:new Date().toISOString(),scope:'Your messages currently loaded on this device',messages},null,2)],{type:'application/json'}),'tavern-messages.json')}
export async function exportEncryptionKeys(password:string){if(password.length<12)throw new Error('Use a passphrase of at least 12 characters.');const c=requireClient(),keys=await c.getCrypto()!.exportRoomKeys();const {OlmMachine,initAsync}=await import('@matrix-org/matrix-sdk-crypto-wasm');await initAsync();const encrypted=OlmMachine.encryptExportedRoomKeys(JSON.stringify(keys),password,500000);downloadBlob(new Blob([encrypted],{type:'text/plain'}),'tavern-encrypted-keys.txt')}
export async function importEncryptionKeys(file:File,password:string){if(file.size>20*1024*1024)throw new Error('Key file is too large.');const {OlmMachine,initAsync}=await import('@matrix-org/matrix-sdk-crypto-wasm');await initAsync();const data=JSON.parse(OlmMachine.decryptExportedRoomKeys(await file.text(),password));if(!Array.isArray(data))throw new Error('Invalid key file.');await requireClient().getCrypto()!.importRoomKeys(data);notify()}

export async function resolveMatrixMessage(roomId:string,id:string){const room=roomRequired(roomId),c=requireClient();let event=room.findEventById(id)||eventCache.get(id);if(!event){const raw=await c.fetchRoomEvent(roomId,id);event=c.getEventMapper()({...raw,room_id:roomId});}if(event.isEncrypted())await c.decryptEventIfNeeded(event).catch(()=>{});eventCache.set(id,event);return normalize(room,event);}

export async function revokeMatrixDevice(deviceId:string,password:string){
 const c=requireClient();if(deviceId===c.getDeviceId())throw new Error('Use Sign out for this device.');
 try { await c.deleteDevice(deviceId); }
 catch(error){
  const e=error as any,challenge=e.data;
  if(e.httpStatus!==401||!challenge?.session||!challenge.flows?.some((f:any)=>f.stages?.includes('m.login.password')))throw error;
  await c.deleteDevice(deviceId,{type:'m.login.password',identifier:{type:'m.id.user',user:c.getUserId()!},password,session:challenge.session});
 }
}
export function matrixTyping(roomId:string){const c=getMatrixClient();return c?.getRoom(roomId)?.getJoinedMembers().filter(m=>m.typing&&m.userId!==c.getUserId()).map(m=>safeString(m.name,m.userId))||[];}
export async function sendMatrixTyping(roomId:string,typing:boolean){const c=getMatrixClient();if(c?.getRoom(roomId)?.getMyMembership()==='join')await c.sendTyping(roomId,typing,15000);}
