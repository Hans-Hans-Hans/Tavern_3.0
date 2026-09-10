'use client';
// Matrix is the source of truth. The self-hosted gateway forwards Matrix requests to Synapse.
import { readInstanceConfig } from './instance';
import { markRoomsRead, roomReadCounts, watchRoomReadCounts } from './read-state';
import { isPrivateDiscussion } from './conversation-routing';
import { addDirectMessage, directRoomId, readDirectMessageMap } from './dm-account-data';
import { readMatrixAttachment } from './attachment-transfer';
import { resolveJoinedEvent } from './resolve-event';
import { readJoinedRoom } from './room-read-scope';
import { JoinedMessageHistory } from './message-history';
import { loadOlderThreadHistory, readThreadSnapshot, threadHistoryHasOlder } from './thread-history';
import { discoverThreadParticipants, type ThreadParticipantOptions } from './thread-participants';
import { disposeCachedImageOwner } from './image-cache';
import { hydrateSelfProfile, nativeSelfProfile, clearSelfProfile } from './self-profile';
import { webhookMetadata } from './webhook-metadata';
import { serverCreationState } from './server-defaults';
import { HttpApiEvent } from 'matrix-js-sdk/lib/http-api/interface';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { readServerEmoji, serverEmojiHtml } from './server-emoji';
import { expandRoleMentions, checkRoleMentionSize } from './role-mentions';
import { indexReactions, type Reaction } from './message-projection';
import { applyPresenceMode } from './presence';
import { initializeAppearance, resetAppearance } from './appearance';
import { initializeOutbox, resetOutbox } from './outbox';
import { attachmentTransaction, validateQueuedAttachments, type QueuedAttachment, type UploadedAttachment } from './outbox-attachments';
import { sendMatrixTransaction } from './send-matrix-transaction';
import { readMatrixSendAttempt, rememberMatrixSendAttempt, forgetMatrixSendAttempt, resetMatrixSendAttempts, assertMatrixSendAttemptCapacity } from './matrix-send-attempt';
import { initializeSearch, resetSearch, searchMessages } from './search-index';
import { initializeNotifications, resetNotifications } from './notifications';
import { initializeCalls, resetCalls } from './calls';
import { cryptoCallbacks, initializeSecurity, resetSecurity, securityOperationInProgress, prepareHistoryRecovery } from './security';
import { cryptoStoreLock, cryptoStorePrefix } from './local-history-recovery';
import { accountArtworkOwner, notifyAccountRequirement, requestApi, isManagedAccount, accountSignedOut, type AccountSession } from './api';
let client:MatrixClient|null=null;
let sessionPromise:Promise<boolean>|null=null;
let releaseLock:(()=>void)|null=null;
let stopReadCounts:(()=>void)|null=null;
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
export function threadHasOlder(roomId:string,rootId:string){const c=client,room=c?.getRoom(roomId);return !!c&&!!room&&threadHistoryHasOlder(c,room,rootId);}
export async function loadThreadHistory(roomId:string,rootId:string){const c=requireClient(),room=roomRequired(roomId);await readJoinedRoom(c,room,()=>client===c,()=>loadOlderThreadHistory(c,room,rootId,eventCache.get(rootId),()=>client===c),()=>notify());}
export async function discoverMatrixThreadParticipants(roomId:string,rootId:string,options:ThreadParticipantOptions={}){const c=requireClient(),room=roomRequired(roomId),actor=c.getUserId(),device=c.getDeviceId(),owner=accountArtworkOwner();const current=()=>client===c&&c.getUserId()===actor&&c.getDeviceId()===device&&accountArtworkOwner()===owner;return discoverThreadParticipants(c,room,rootId,eventCache.get(rootId),current,options);}
function baseUrl(value:string){const u=new URL(value);if(u.protocol!=='https:')throw new Error('Use an HTTPS homeserver address.');if(u.username||u.password||u.search||u.hash)throw new Error('Enter only the HTTPS homeserver address.');return u.href.replace(/\/$/,'')}
async function attachSession(s:any){
 sdk??=await import('matrix-js-sdk');
 if(client)return true;
 if(!navigator.locks)throw new Error('Your browser needs Web Locks support to safely use encrypted messaging. Try a current Chrome, Edge, or Firefox.');
 let unlock!:()=>void;
 const held=new Promise<void>(r=>unlock=r);
 await new Promise<void>((resolve,reject)=>{navigator.locks.request(cryptoStoreLock(s.userId,s.deviceId),{ifAvailable:true},async lock=>{if(!lock){reject(new Error('This Matrix session is already open in another tab. Use that tab to protect your encryption keys.'));return;}releaseLock=unlock;resolve();await held;}).catch(reject)});
 const c=sdk.createClient({baseUrl:baseUrl(s.baseUrl),accessToken:s.accessToken,userId:s.userId,deviceId:s.deviceId,timelineSupport:true,verificationMethods:['m.sas.v1'],cryptoCallbacks:cryptoCallbacks(()=>c),forceTURN:true,fallbackICEServerAllowed:false,...(s.managed?{fetchFn:((url:any,options:any)=>{const target=new URL(String(url),location.origin);if(target.origin!==location.origin)throw new Error('Account requests must stay on this Tavern instance.');return fetch(url,{...options,credentials:'same-origin'}).then(async response=>{if(response.status===403)notifyAccountRequirement(await response.clone().json().catch(()=>null));return response;});}) as typeof fetch}:{})});
 try{
  syncState='Initializing encryption';notify();
  await c.initRustCrypto({cryptoDatabasePrefix:cryptoStorePrefix(s.userId,s.deviceId)});
  client=c;c.on(HttpApiEvent.SessionLoggedOut,()=>{clearLocalMatrixSession();if(s.managed)accountSignedOut();});initializeSecurity(c);initializeCalls(c);initializeNotifications(c);stopReadCounts=watchRoomReadCounts(c,()=>{if(client===c)notify();});
  c.on(sdk.ClientEvent.Sync,state=>{syncState=state==='PREPARED'||state==='SYNCING'?'Connected':state==='ERROR'?'Reconnecting':state;notify()});
  c.on(sdk.RoomEvent.Timeline,notify);c.on(sdk.RoomEvent.Receipt,notify);c.on(sdk.RoomEvent.MyMembership,notify);c.on(sdk.MatrixEventEvent.Decrypted,notify);c.on(sdk.RoomEvent.LocalEchoUpdated,notify);c.on(sdk.RoomMemberEvent.Typing,notify);c.on(sdk.RoomStateEvent.Events,notify);c.on(sdk.RoomMemberEvent.Name,notify);c.on(sdk.UserEvent.Presence,notify);c.on(sdk.ClientEvent.AccountData,notify);
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{c.off(sdk.ClientEvent.Sync,onSync);reject(new Error('The homeserver did not complete the initial sync. Please reconnect.'))},45000);const onSync=(state:string,_prev?:string|null,data?:any)=>{if(state==='ERROR'&&data?.error?.errcode==='M_UNKNOWN_TOKEN'){clearTimeout(timeout);c.off(sdk.ClientEvent.Sync,onSync);reject(data.error);}if(state==='PREPARED'){clearTimeout(timeout);c.off(sdk.ClientEvent.Sync,onSync);resolve()}};c.on(sdk.ClientEvent.Sync,onSync);c.startClient({initialSyncLimit:60,lazyLoadMembers:true,threadSupport:true,pollTimeout:30000}).catch(e=>{clearTimeout(timeout);c.off(sdk.ClientEvent.Sync,onSync);reject(e)})});
  void prepareHistoryRecovery(c).catch(()=>{});
  await hydrateSelfProfile(c,()=>client===c);
  await applyPresenceMode(c).catch(()=>{});
  initializeAppearance(c);const outboxAccount=accountArtworkOwner();void initializeOutbox(c,(item,checkpoint)=>matrixApi('send',{conversation:item.roomId,parent:item.parent,serverId:item.serverId,body:item.body,nonce:item.id,outboxAttachments:item.attachments,bodyEventId:item.bodyEventId,preparedContent:item.preparedContent,preparedRoleUsers:item.preparedRoleUsers,preparedEncrypted:item.encrypted,checkpoint}),{current:()=>client===c&&accountArtworkOwner()===outboxAccount,cancelled:id=>forgetMatrixSendAttempt(c,id),upload:async(file,item)=>{const uploaded=await uploadMatrixFile(file,item.roomId);discardMatrixFile(uploaded.id);return uploaded;}}).catch(error=>console.warn('Local outbox unavailable:',error.message));
  const searchOwner=accountArtworkOwner();void initializeSearch(c,()=>client===c&&accountArtworkOwner()===searchOwner).catch(error=>console.warn('Local search unavailable:',error.message));
  return true;
 }catch(e){stopReadCounts?.();stopReadCounts=null;resetOutbox();resetAppearance();resetSearch();resetNotifications();resetCalls();resetSecurity();c.stopClient();client=null;syncState='Not connected';releaseLock?.();releaseLock=null;throw e}
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
export function clearLocalMatrixSession(){stopReadCounts?.();stopReadCounts=null;const c=client;if(c){disposeCachedImageOwner(c);clearSelfProfile(c);}resetOutbox();resetAppearance();resetSearch();resetNotifications();resetCalls();resetSecurity();c?.stopClient();c?.removeAllListeners();client=null;sessionStorage.removeItem(sessionKey);sessionPromise=null;pendingFiles.clear();resetMatrixSendAttempts();eventCache.clear();lastReceipts.clear();accountQueues.clear();releaseLock?.();releaseLock=null;syncState='Not connected';notify()}
export async function disconnectMatrix(){if(securityOperationInProgress())throw new Error('Wait for the encryption operation to finish before signing out.');if(sessionPromise)throw new Error('Wait for the current connection attempt to finish.');if(isManagedAccount())await requestApi('/auth/logout',{});else if(client)await client.logout();clearLocalMatrixSession();if(isManagedAccount())accountSignedOut()}
function requireClient(){if(!client)throw new Error('Connect your Matrix homeserver to start messaging.');return client}
const writeAccount=(key:string,value:any)=>(requireClient() as any).setAccountData(key,value);
const account=(key:string)=>client?.getAccountData(key as any)?.getContent()||{};
function mutateAccount(key:string,mutate:(old:any)=>any,owner:MatrixClient=requireClient(),generation=accountArtworkOwner()){
 const actor=owner.getUserId();
 const current=()=>{if(client!==owner||owner.getUserId()!==actor||accountArtworkOwner()!==generation)throw new Error('Your account changed. Retry this action from your current account.');};
 const task=(accountQueues.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
  current();const value=mutate(owner.getAccountData(key as any)?.getContent()||{});current();
  await (owner as any).setAccountData(key,value);current();
 });
 accountQueues.set(key,task);return task;
}
/** Share the account-data queue, but keep consent bound to the initiating session.
 * getAccountDataFromServer uses the sync cache after startup, so read this merge
 * from the native endpoint instead. Matrix account data has no cross-device CAS. */
export function mutateMatrixAccountData(owner:MatrixClient,key:string,mutate:(old:any)=>any,validate:()=>void){
 const actor=owner.getUserId();
 const current=()=>{if(client!==owner||owner.getUserId()!==actor)throw new Error('Your account changed. Reopen the request.');validate();};
 const task=(accountQueues.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
  current();let value:any;
  try{value=await owner.http.authedRequest('GET' as any,'/user/'+encodeURIComponent(actor!)+'/account_data/'+encodeURIComponent(key));}
  catch(error){if((error as any)?.errcode!=='M_NOT_FOUND')throw error;value={};}
  current();await (owner as any).setAccountData(key,mutate(value));current();notify();
 });
 accountQueues.set(key,task);return task;
}
export function markMatrixRoomsRead(roomIds?:readonly string[]){
 const owner=requireClient(),actor=owner.getUserId(),generation=accountArtworkOwner();
 return markRoomsRead({client:owner,current:()=>client===owner&&owner.getUserId()===actor&&accountArtworkOwner()===generation,mutateAccountData:(key,update,validate)=>mutateMatrixAccountData(owner,key,update,validate)},roomIds);
}
const savedEvents=()=>Array.isArray(account(savedKey).events)?account(savedKey).events.filter((x:any)=>typeof x?.id==='string'&&typeof x?.roomId==='string').slice(0,500):[];
function allEvents(room:Room){return [...new Map([...room.getLiveTimeline().getEvents(),...room.getThreads().flatMap(t=>t.events)].map(e=>[e.getId(),e])).values()];}
const joined=()=>client?.getRooms().filter(r=>r.getMyMembership()==='join'&&!r.isSpaceRoom())||[];
function roomRequired(id:string){const r=requireClient().getRoom(id);if(!r||r.getMyMembership()!=='join')throw new Error('Join this conversation before opening it.');return r}
function directIds(){return new Set(Object.values(account('m.direct')).flatMap(safeStrings))}
function normalize(room:Room,event:MatrixEvent,context?:{reactions:Map<string,Reaction[]>;pinned:Set<string>;saved:Set<string>}){
 const c=event.getContent()||{},me=client?.getUserId(),id=event.getId()!,sender=event.getSender()!;
 const relation=event.getRelation();eventCache.set(id,event);if(eventCache.size>5000)eventCache.delete(eventCache.keys().next().value!);
 const reactions=(context?.reactions||indexReactions(allEvents(room),me)).get(id)||[];
 const pinned=context?.pinned||new Set(safeStrings(room.currentState.getStateEvents('m.room.pinned_events','')?.getContent().pinned));
 const thread=room.getThread(id);
 const encrypted=event.isEncrypted();
 const file=c.file&&typeof c.file==='object'&&typeof c.file.url==='string'?c.file:null;
 return {id,webhook:webhookMetadata(c['io.tavern.webhook']),forum:c['io.tavern.forum']&&typeof c['io.tavern.forum']==='object'?{title:safeString(c['io.tavern.forum'].title).slice(0,120),tags:safeStrings(c['io.tavern.forum'].tags).slice(0,10)}:null,lastActivity:thread?.events.at(-1)?.getTs()||event.getTs(),body:event.isDecryptionFailure()?'🔒 Unable to decrypt on this device. Open History recovery to restore saved message keys.':safeString(c.body,'[Unsupported message]'),author_id:sender,author_name:safeString(room.getMember(sender)?.name,sender),conversation_id:room.roomId,conversation_name:safeString(room.name,room.roomId),created_at:event.getTs(),edited_at:event.replacingEventDate()?.getTime()||null,parent_id:relation?.rel_type==='m.thread'?relation.event_id||null:null,pinned:Number(pinned.has(id)),saved:Number(context?context.saved.has(id):savedEvents().some((x:any)=>x.id===id)),replies:thread?.length||0,reactions,attachments:['m.file','m.image','m.video','m.audio'].includes(c.msgtype||'')&&(c.url||file?.url)?[{id,name:safeString(c.filename,safeString(c.body,'Attachment')),size:typeof c.info?.size==='number'?c.info.size:0,url:safeString(c.url,file?.url),file,encrypted,type:safeString(c.info?.mimetype),width:Number(c.info?.w)||undefined,height:Number(c.info?.h)||undefined,thumbnail:c.info?.thumbnail_file?.url||c.info?.thumbnail_url?{url:safeString(c.info?.thumbnail_file?.url,c.info?.thumbnail_url),file:c.info?.thumbnail_file||null,type:safeString(c.info?.thumbnail_info?.mimetype)}:null}]:[],encrypted,sending:!!event.status};
}
async function getRoomMessages(room:Room,parent?:string,includeThreads=false){
 const owner=requireClient(),account=accountArtworkOwner();let validateThread=()=>{};const current=()=>client===owner&&(!parent||accountArtworkOwner()===account);return readJoinedRoom(owner,room,current,async()=>{
 let events=includeThreads?allEvents(room):room.getLiveTimeline().getEvents();
 if(parent){const snapshot=await readThreadSnapshot(owner,room,parent,eventCache.get(parent),current);events=snapshot.events;validateThread=snapshot.assertCurrent;validateThread();}
 await Promise.all(events.filter(e=>e.isEncrypted()).map(e=>owner.decryptEventIfNeeded(e).catch(()=>{})));
 validateThread();
 return events;
 },events=>{
 validateThread();
 const context={reactions:indexReactions(allEvents(room),owner.getUserId()),pinned:new Set(safeStrings(room.currentState.getStateEvents('m.room.pinned_events','')?.getContent().pinned)),saved:new Set<string>(savedEvents().map((e:any)=>e.id))};
 return events.filter(e=>(e.getType()==='m.room.message'||e.isDecryptionFailure())&&!e.isRedacted()&&e.getContent()['m.relates_to']?.rel_type!=='m.replace').map(e=>normalize(room,e,context)).filter(m=>parent?m.parent_id===parent:includeThreads||!m.parent_id);
 });
}
export async function matrixApi(action:string,p?:any,params:Record<string,string>={}):Promise<any>{
 if(action==='bootstrap'){
  if(!client){let preferences={};try{preferences=JSON.parse(localStorage.getItem('harbor.appearance')||'{}')}catch{}return {me:{id:'preview',name:'You',role:'member'},workspace:{name:'Tavern'},members:[{id:'preview',name:'You',role:'member'}],conversations:[],memberships:[],preferences:safePrefs(preferences),preview:true,servers:[],invitations:[]}}
  const c=client,me=c.getUserId()!,rooms=joined(),dms=directIds(),members=new Map<string,any>(),memberships:any[]=[];
  for(const r of rooms)for(const m of r.getJoinedMembers()){members.set(m.userId,{id:m.userId,name:safeString(m.name,m.userId),role:'member'});memberships.push({conversation_id:r.roomId,user_id:m.userId});}
  const profile=nativeSelfProfile(c);members.set(me,{id:me,name:safeString(profile.name,me),role:'member'});
  return {me:{...members.get(me),email:me},workspace:{name:safeString(account(workspaceKey).name,new URL(c.getHomeserverUrl()).hostname)},members:[...members.values()],memberships,conversations:rooms.filter(r=>!isPrivateDiscussion(r)).map(r=>({id:r.roomId,name:safeString(r.name,r.roomId),description:safeString(r.currentState.getStateEvents('m.room.topic','')?.getContent().topic,'A place for your conversations.'),kind:dms.has(r.roomId)?'dm':'channel',...roomReadCounts(r),encrypted:r.hasEncryptionStateEvent(),private:r.getJoinRule()!=='public'})),servers:c.getRooms().filter(r=>r.isSpaceRoom()&&r.getMyMembership()==='join').map(r=>({id:r.roomId,name:safeString(r.name,r.roomId),roomIds:r.currentState.getStateEvents('m.space.child').filter(e=>safeStrings(e.getContent().via).length>0).map(e=>e.getStateKey()!)})),preferences:safePrefs(account(prefsKey)),invitations:c.getRooms().filter(r=>r.getMyMembership()==='invite').map(r=>({id:r.roomId,name:safeString(r.name,r.roomId)})),preview:false};
 }
 if(action==='preferences'){p=safePrefs(p);localStorage.setItem('harbor.appearance',JSON.stringify(p));if(client)await writeAccount(prefsKey,p);return {preferences:p}}
 if(!client&&['messages','search','saved','threads','mentions','files'].includes(action))return {messages:[],hasMore:false};
 const c=requireClient(),me=c.getUserId()!;
 if(action==='search'){const result=await searchMessages(params.q||'',{cursor:params.cursor});return {...result,messages:result.hits.map(m=>({id:m.id,body:m.body,author_id:m.authorId,author_name:m.authorName,conversation_id:m.roomId,conversation_name:m.roomName,created_at:m.timestamp,parent_id:null,replies:0,reactions:[],attachments:[]}))};}
 if(['messages','search','saved','threads','mentions','files'].includes(action)){
  if(params.parent&&!params.conversation)throw new Error('Choose a conversation before opening a thread.');
  const rooms=params.conversation?[roomRequired(params.conversation)]:joined();
  if(params.before){if(params.parent)await loadOlderThreadHistory(c,rooms[0],params.parent,eventCache.get(params.parent),()=>client===c);else await c.scrollback(rooms[0],100);}
  let all=(await Promise.all(rooms.map(r=>getRoomMessages(r,params.parent,action!=='messages'&&action!=='threads')))).flat();
  if(action==='saved'){all=[];const saved=savedEvents();for(let i=0;i<saved.length;i+=8){const batch=await Promise.all(saved.slice(i,i+8).map((m:any)=>resolveMatrixMessage(m.roomId,m.id).catch(()=>null)));all.push(...batch.filter(Boolean));}}
  if(client!==c)throw new Error('Your account changed. Reopen the conversation.');
  if(action==='search'){const q=params.q.toLocaleLowerCase();all=all.filter(m=>m.body.toLocaleLowerCase().includes(q));}
  if(action==='saved')all=all.filter(m=>m.saved);
  if(action==='threads')all=all.filter(m=>m.replies>0);
  if(action==='files')all=all.filter(m=>m.attachments.length>0);
  if(action==='mentions')all=all.filter(m=>{const e=c.getRoom(m.conversation_id)?.findEventById(m.id);const mentions=e?.getContent()['m.mentions'];return mentions?.user_ids?.includes(me)||mentions?.room||m.body.includes(me)});
  all.sort((a,b)=>action==='messages'?a.created_at-b.created_at:b.created_at-a.created_at);
  return {messages:all,hasMore:action==='messages'&&(params.parent?threadHistoryHasOlder(c,rooms[0],params.parent):!!rooms[0]?.getLiveTimeline().getPaginationToken(sdk.Direction.Backward))};
 }
 if(action==='read'){const room=roomRequired(p.conversation);const event=p.id?room.findEventById(p.id):null;if(event&&!event.status&&lastReceipts.get(room.roomId)!==p.id){lastReceipts.set(room.roomId,p.id);try{await c.sendReadReceipt(event,sdk.ReceiptType.ReadPrivate)}catch(e){lastReceipts.delete(room.roomId);throw e}}return {ok:true}}
 if(action==='send'){
  const room=roomRequired(p.conversation);if(p.parent){const root=room.findEventById(p.parent);if(root&&root.getRoomId()!==room.roomId)throw new Error('Thread belongs to another room.');}
  const owner=accountArtworkOwner(),actor=c.getUserId(),device=c.getDeviceId(),homeserver=c.getHomeserverUrl(),encryptedRoom=room.hasEncryptionStateEvent(),current=()=>client===c&&accountArtworkOwner()===owner&&c.getUserId()===actor&&c.getDeviceId()===device&&c.getHomeserverUrl()===homeserver&&c.getRoom(room.roomId)===room&&room.getMyMembership()==='join'&&room.hasEncryptionStateEvent()===encryptedRoom;
  const expanded=p.suppressMentions?null:await expandRoleMentions(c,room.roomId,p.body,current);
  if(!current())throw new Error('Your account or conversation changed. Your draft is kept.');
  const mentionBody=expanded?.bodyForUserMentions??p.body;
  let content:any={msgtype:'m.text',body:p.body,'m.mentions':{user_ids:p.suppressMentions?[]:[...new Set([...room.getJoinedMembers().filter(m=>mentionBody.includes('@'+m.name)||mentionBody.includes(m.userId)).map(m=>m.userId),...(expanded?.userIds||[])])]}};
  const formatted=serverEmojiHtml(p.body,readServerEmoji(p.serverId));if(formatted){content.format='org.matrix.custom.html';content.formatted_body=formatted;}
  if(p.forum){content['io.tavern.forum']={title:safeString(p.forum.title).slice(0,120),tags:safeStrings(p.forum.tags).slice(0,10).map(t=>t.slice(0,32))};}
  if(!p.suppressMentions&&mentionBody.includes('@everyone'))content['m.mentions'].room=true;
  const roleUsers=[...(expanded?.userIds||[])].sort();
  const original=p.preparedContent?{preparedContent:p.preparedContent,preparedRoleUsers:p.preparedRoleUsers||[],encrypted:p.preparedEncrypted}:readMatrixSendAttempt(c,room,p.parent,p.nonce);
  if(original){
   if(original.preparedContent.msgtype!=='m.text'||original.preparedContent.body!==p.body||original.encrypted!==room.hasEncryptionStateEvent())throw new Error('The original pending message or conversation encryption changed. Check the conversation before replacing it.');
   if(JSON.stringify(original.preparedRoleUsers)!==JSON.stringify(roleUsers))throw new Error('Role mention recipients changed after the original send attempt. The saved transaction will not notify a different audience.');
   content=structuredClone(original.preparedContent);
  }
  if(expanded)checkRoleMentionSize(content['m.mentions'],content);
  const checkSend=()=>{if(!current())throw new Error('Your account or conversation changed. Your draft is kept.');expanded?.assertCurrent();};
  const remember=()=>rememberMatrixSendAttempt(c,room,p.parent,p.nonce,{attempted:true,preparedContent:content,preparedRoleUsers:roleUsers,encrypted:room.hasEncryptionStateEvent()},current);
  const attachments:any[]=p.outboxAttachments?structuredClone(p.outboxAttachments):(p.attachments||[]).map((id:string,i:number)=>{const f=pendingFiles.get(id);if(!f||f.roomId!==room.roomId||!f.owned?.())throw new Error('Reattach this file before sending.');if(f.transactionId&&f.parent!==p.parent)throw new Error('This attempted file belongs to another thread. Check its original conversation.');f.transactionId??=attachmentTransaction(p.nonce,i);f.parent=p.parent;return {id,name:f.name,size:f.size,type:f.type,transactionId:f.transactionId,eventId:f.eventId,descriptor:f};});
  if(p.outboxAttachments)validateQueuedAttachments(attachments,room.roomId);
  checkSend();assertMatrixSendAttemptCapacity(c,p.nonce);await p.checkpoint?.prepare(content,room.hasEncryptionStateEvent(),roleUsers);checkSend();
  for(const attachment of attachments){
   if(attachment.eventId)continue;checkSend();
   const f=attachment.descriptor||await p.checkpoint?.upload(attachment.id,checkSend);checkSend();
   if(!f||f.roomId!==room.roomId||room.hasEncryptionStateEvent()&&!f.file)throw new Error('This pending file does not match the conversation encryption. Reattach it before sending a replacement.');
   const fc={msgtype:f.type.startsWith('image/')?'m.image':f.type.startsWith('video/')?'m.video':f.type.startsWith('audio/')?'m.audio':'m.file',body:f.name,filename:f.name,info:{size:f.size,mimetype:f.type,...f.info},...(f.file?{file:f.file}:{url:f.url})};
   remember();const ack=await sendMatrixTransaction(c,room,fc,attachment.transactionId,p.parent,current);
   if(!p.outboxAttachments){const pending=pendingFiles.get(attachment.id);if(pending?.owned?.()&&pending.transactionId===attachment.transactionId)pending.eventId=ack.event_id;}
   await p.checkpoint?.attachment(attachment.id,attachment.transactionId,ack.event_id);
  }
  if(p.body.trim()&&!p.bodyEventId){checkSend();remember();const ack=await sendMatrixTransaction(c,room,content,p.nonce,p.parent,current);await p.checkpoint?.body(ack.event_id);}
  if(!current())throw new Error('Your account changed after sending. Reopen the conversation.');
  for(const id of p.attachments||[])pendingFiles.delete(id);forgetMatrixSendAttempt(c,p.nonce);notify();return {ok:true};
 }
 if(['react','save','pin','edit','delete'].includes(action)){
  const room=joined().find(r=>r.findEventById(p.id)||r.getThreads().some(t=>t.findEventById(p.id))||eventCache.get(p.id)?.getRoomId()===r.roomId);
  if(!room)throw new Error('Load this message before changing it.');const e=room.findEventById(p.id)||room.getThreads().map(t=>t.findEventById(p.id)).find(Boolean)||eventCache.get(p.id)!;
  if(action==='react'){
   const old=allEvents(room).find(e=>e.getType()==='m.reaction'&&!e.isRedacted()&&e.getSender()===me&&e.getContent()['m.relates_to']?.event_id===p.id&&e.getContent()['m.relates_to']?.key===p.emoji);
   if(old)await c.redactEvent(room.roomId,old.getId()!);else await c.sendEvent(room.roomId,'m.reaction' as any,{'m.relates_to':{rel_type:'m.annotation',event_id:p.id,key:p.emoji}});
  }
  if(action==='save'){await mutateAccount(savedKey,old=>{const saved=Array.isArray(old.events)?old.events:[];if(saved.length>=500&&!saved.some((x:any)=>x.id===p.id))throw new Error('Your saved list is full. Remove a bookmark first.');return {events:saved.some((x:any)=>x.id===p.id)?saved.filter((x:any)=>x.id!==p.id):[...saved,{id:p.id,roomId:room.roomId}]}},c);}
  if(action==='pin'){const old=room.currentState.getStateEvents('m.room.pinned_events','')?.getContent().pinned||[];await c.sendStateEvent(room.roomId,'m.room.pinned_events' as any,{pinned:old.includes(p.id)?old.filter((id:string)=>id!==p.id):[...old,p.id]},'')}
  if(action==='delete'||action==='edit'){if(action==='edit'&&e.getSender()!==me)throw new Error('You can only edit your own messages.');if(action==='delete'&&e.getSender()!==me&&!room.currentState.hasSufficientPowerLevelFor('redact',room.getMember(me)?.powerLevel||0))throw new Error('You cannot remove this message.');if(action==='delete')await c.redactEvent(room.roomId,p.id);else await c.sendEvent(room.roomId,'m.room.message' as any,{msgtype:'m.text',body:'* '+p.body,'m.new_content':{msgtype:'m.text',body:p.body},'m.relates_to':{rel_type:'m.replace',event_id:p.id}});}
  notify();return {ok:true};
 }
 if(action==='createServer'){
  const name=safeString(p.name).trim().slice(0,60);if(!name)throw new Error('A server name is required.');
  const r=await c.createRoom({name,topic:safeString(p.description).slice(0,200),visibility:sdk.Visibility.Private,preset:sdk.Preset.PrivateChat,creation_content:{type:'m.space','m.federate':false},initial_state:serverCreationState(me,p,(await readInstanceConfig()).serverRolePolicy===true)});
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
  const direct=p.kind==='dm',invite=safeStrings(p.members).filter(id=>id!==me),generation=accountArtworkOwner();
  const device=c.getDeviceId(),homeserver=c.getHomeserverUrl(),current=()=>{if(client!==c||c.getUserId()!==me||c.getDeviceId()!==device||c.getHomeserverUrl()!==homeserver||accountArtworkOwner()!==generation)throw new Error('Your account changed. Reopen Messages before continuing.');};
  const parent=!direct&&p.serverId?roomRequired(p.serverId):null;
  if(parent&&(!parent.isSpaceRoom()||!parent.currentState.maySendStateEvent('m.space.child',me)))throw new Error('You cannot add channels to this server.');
  const via=[me.slice(me.indexOf(':')+1)];
  if(direct){const map=await readDirectMessageMap(c,current);if(!p.group&&invite.length<=1){const existing=map[invite[0]||me]?.find(id=>{const room=c.getRoom(id);return room?.getMyMembership()==='join'&&!room.isSpaceRoom()&&!isPrivateDiscussion(room);});if(existing){current();return {id:existing};}}}
  const instance=await readInstanceConfig();if(direct)current();
  let r;
  try{r=await c.createRoom({name:direct?(p.group?safeString(p.name).slice(0,60):invite.length?undefined:'Notes to self'):p.name,topic:p.description||undefined,visibility:sdk.Visibility.Private,preset:sdk.Preset.PrivateChat,power_level_content_override:{events:{'org.matrix.msc3401.call.member':0,...(instance.serverRolePolicy?{'io.tavern.thread':0}:{})}},is_direct:direct,invite,creation_content:{'m.federate':false},initial_state:[...(parent?[{type:'m.space.parent',state_key:parent.roomId,content:{via,canonical:true}}]:[]),{type:'m.room.encryption',state_key:'',content:{algorithm:'m.megolm.v1.aes-sha2'}},{type:'m.room.history_visibility',state_key:'',content:{history_visibility:'joined'}}]});}
  catch(error){if(!direct)throw error;current();throw new Error('Conversation creation was not confirmed. Check Messages and All conversations before trying again; the room may already exist.');}
  if(direct){
   current();if(!directRoomId(r?.room_id))throw new Error('Conversation creation returned an invalid ID. Check All conversations before creating it again.');
   const peers=invite.length?invite:[me];
   try{
    await mutateMatrixAccountData(c,'m.direct',map=>addDirectMessage(map,peers,r.room_id),current);
    const saved=await readDirectMessageMap(c,current);
    if(!peers.every(peer=>saved[peer]?.includes(r.room_id)))throw new Error('The Messages list changed on another device before persistence could be confirmed.');
   }catch(error){current();notify();throw new Error('The conversation was created ('+r.room_id+'), but saving it in Messages was not confirmed. Find it in All conversations before creating another. '+(error as Error).message);}
  }
  if(parent){try{await c.sendStateEvent(parent.roomId,'m.space.child' as any,{via},r.room_id)}catch{await c.joinRoom(r.room_id);notify();throw new Error('Channel created, but adding it to the server failed. It is available in All conversations.');}}
  // /sync supplies authoritative state; joinRoom makes the new room locally available.
  if(direct)current();await c.joinRoom(r.room_id);if(direct)current();notify();return {id:r.room_id};
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
 const actor=c.getUserId(),device=c.getDeviceId(),owner=accountArtworkOwner(),homeserver=c.getHomeserverUrl(),encryptedRoom=room.hasEncryptionStateEvent();
 const owned=()=>client===c&&c.getUserId()===actor&&c.getDeviceId()===device&&c.getHomeserverUrl()===homeserver&&accountArtworkOwner()===owner&&c.getRoom(roomId)===room&&room.getMyMembership()==='join'&&room.hasEncryptionStateEvent()===encryptedRoom;
 const check=()=>{options.signal?.throwIfAborted();if(!owned())throw new Error('Your account, membership or encryption changed during upload. Attach the file again from the current conversation.');};
 check();
 let descriptor:any=null,data:Blob=file;
 if(encryptedRoom){const {encryptAttachment}=await import('matrix-encrypt-attachment');check();const bytes=await file.arrayBuffer();check();const encrypted=await encryptAttachment(bytes);check();descriptor=encrypted.info;data=new Blob([encrypted.data],{type:'application/octet-stream'});}
 check();const abortController=new AbortController(),abort=()=>abortController.abort();options.signal?.addEventListener('abort',abort,{once:true});
 let uploaded;try{uploaded=await c.uploadContent(data,{includeFilename:false,type:descriptor?'application/octet-stream':file.type||'application/octet-stream',abortController,progressHandler:p=>{if(owned())options.onProgress?.(p.loaded,p.total||data.size);}});}finally{options.signal?.removeEventListener('abort',abort);}
 check();
 const info:any={};
 const {createMediaPreview}=await import('./media-processing');check();const preview=await createMediaPreview(file,options.signal);check();
 if(preview){info.w=preview.sourceWidth;info.h=preview.sourceHeight;if(preview.duration!==undefined)info.duration=preview.duration;try{
  let thumbnailData=preview.blob,thumbnailFile:any=null;
  if(descriptor){const {encryptAttachment}=await import('matrix-encrypt-attachment');check();const bytes=await preview.blob.arrayBuffer();check();const encrypted=await encryptAttachment(bytes);check();thumbnailData=new Blob([encrypted.data],{type:'application/octet-stream'});thumbnailFile=encrypted.info;}
  check();const thumbAbort=new AbortController(),cancelThumb=()=>thumbAbort.abort();options.signal?.addEventListener('abort',cancelThumb,{once:true});let result;
  try{result=await c.uploadContent(thumbnailData,{includeFilename:false,type:thumbnailData.type,abortController:thumbAbort});}finally{options.signal?.removeEventListener('abort',cancelThumb);}
  check();if(thumbnailFile)info.thumbnail_file={...thumbnailFile,url:result.content_uri};else info.thumbnail_url=result.content_uri;
  info.thumbnail_info={w:preview.width,h:preview.height,size:preview.blob.size,mimetype:preview.blob.type};
 }catch(error){check();}}
 check();
 const id=crypto.randomUUID(),record={id,name:file.name,size:file.size,type:file.type,roomId,info,url:uploaded.content_uri,file:descriptor?{...descriptor,url:uploaded.content_uri}:null};pendingFiles.set(id,{...record,owned});return record;
}
/** Copy only encrypted delivery metadata, never the captured live SDK owner. */
export function snapshotMatrixAttachments(ids:readonly string[],roomId:string,parent:string|undefined,nonce:string):QueuedAttachment[]{
 roomRequired(roomId);const result=ids.map((id,index)=>{const pending=pendingFiles.get(id);
  if(!pending||pending.roomId!==roomId||!pending.owned?.())throw new Error('This attachment belongs to an earlier account or conversation. Reattach it.');
  if(pending.transactionId&&pending.parent!==parent)throw new Error('An attempted file belongs to its original thread. Check that conversation before replacing it.');
  const {name,size,type,url,file,info}=pending;
  const descriptor:UploadedAttachment={id,roomId,name,size,type,url,file,info};
  return {id,name,size,type,descriptor:structuredClone(descriptor),transactionId:pending.transactionId||attachmentTransaction(nonce,index),...(pending.eventId?{eventId:pending.eventId}:{})};
 });validateQueuedAttachments(result,roomId);return result;
}
export function discardMatrixFile(id:string){pendingFiles.delete(id);}
export function snapshotMatrixSendAttempt(roomId:string,parent:string|undefined,nonce:string){return readMatrixSendAttempt(requireClient(),roomRequired(roomId),parent,nonce)||{};}
export async function matrixFileBlob(a:any,signal?:AbortSignal,maxBytes=20*1024*1024){
 const c=requireClient();return readMatrixAttachment(c,a,maxBytes,()=>client===c,signal);
}
export async function downloadMatrixFile(a:any){downloadBlob(await matrixFileBlob(a),a.name)}
function downloadBlob(blob:Blob,name:string){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000)}
export async function exportMatrixMessages(){const c=requireClient();const messages=(await Promise.all(joined().map(r=>getRoomMessages(r)))).flat().filter(m=>m.author_id===c.getUserId());downloadBlob(new Blob([JSON.stringify({exportedAt:new Date().toISOString(),scope:'Your messages currently loaded on this device',messages},null,2)],{type:'application/json'}),'tavern-messages.json')}
export async function exportEncryptionKeys(password:string){
 if(password.length<12)throw new Error('Use a passphrase of at least 12 characters.');
 const c=requireClient(),crypto=c.getCrypto()!,check=()=>{if(client!==c||c.getCrypto()!==crypto)throw new Error('Your signed-in session changed. Retry from the current session.');};
 let keys='';try{keys=await crypto.exportRoomKeysAsJson();check();const {OlmMachine,initAsync}=await import('@matrix-org/matrix-sdk-crypto-wasm');await initAsync();check();const encrypted=OlmMachine.encryptExportedRoomKeys(keys,password,500000);check();downloadBlob(new Blob([encrypted],{type:'text/plain'}),'tavern-encrypted-keys.txt');}finally{keys='';}
}
export async function importEncryptionKeys(file:File,password:string){
 if(file.size>20*1024*1024)throw new Error('Key file is too large.');
 const c=requireClient(),crypto=c.getCrypto()!,check=()=>{if(client!==c||c.getCrypto()!==crypto)throw new Error('Your signed-in session changed. Retry from the current session.');};
 let data='';try{const {OlmMachine,initAsync}=await import('@matrix-org/matrix-sdk-crypto-wasm');await initAsync();check();const text=await file.text();check();data=OlmMachine.decryptExportedRoomKeys(text,password);check();await crypto.importRoomKeysAsJson(data);check();notify();}finally{data='';}
}

export async function resolveMatrixMessage(roomId:string,id:string){const c=requireClient(),owner=accountArtworkOwner(),actor=c.getUserId(),device=c.getDeviceId(),homeserver=c.getHomeserverUrl(),{room,event}=await resolveJoinedEvent(c,roomId,id,eventCache.get(id),()=>client===c&&accountArtworkOwner()===owner&&c.getUserId()===actor&&c.getDeviceId()===device&&c.getHomeserverUrl()===homeserver);return normalize(room,event);}
export function createMatrixMessageHistory(roomId:string,eventId:string,current:()=>boolean){
 const c=requireClient(),room=roomRequired(roomId),owner=accountArtworkOwner();
 return new JoinedMessageHistory({client:c,room,eventId,current:()=>client===c&&accountArtworkOwner()===owner&&current(),project:events=>{
  const context={reactions:indexReactions([...events,...allEvents(room)],c.getUserId()),pinned:new Set(safeStrings(room.currentState.getStateEvents('m.room.pinned_events','')?.getContent().pinned)),saved:new Set<string>(savedEvents().map((event:any)=>event.id))};
  return events.filter(event=>(event.getType()==='m.room.message'||event.isDecryptionFailure())&&!event.isRedacted()&&event.getContent()['m.relates_to']?.rel_type!=='m.replace'&&event.getRelation()?.rel_type!=='m.thread').map(event=>normalize(room,event,context));
 }});
}

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
