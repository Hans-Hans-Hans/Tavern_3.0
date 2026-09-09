import React from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { SidebarProvider } from '../../../components/ui/sidebar';
import { Workspace } from '../../../app/tavern';
import { defaultRolePolicy } from '../../../lib/roles';
import { isPrivateDiscussion } from '../../../lib/conversation-routing';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any, me='@owner:local', parameters=new URLSearchParams(location.search), client=createClient({baseUrl:location.origin,userId:me,deviceId:'D1'});
  const rooms=new Map<string,any>(),raws=new Map<string,any[]>();w.calls=[];w.listeners=new Set();w.resolved=[];w.notify=()=>w.listeners.forEach((fn:any)=>fn());
  function make(id:string,name:string,kind='',membership='join',source='') {
    const room=new Room(id,client,me,{pendingEventOrdering:'detached'} as any);
    const raw=(type:string,content:any,state_key='')=>({type,content,state_key,room_id:id,event_id:'$'+type+id+state_key,sender:me,origin_server_ts:1000});
    const events=[raw('m.room.create',{room_version:'11','m.federate':false,...(kind?{type:kind}:{}),...(source?{'io.tavern.private_thread':{version:1,source_room_id:source,source_event_id:''}}:{})}),raw('m.room.name',{name}),raw('m.room.member',{membership,displayname:'Owner'},me),raw('m.room.member',{membership:'join',displayname:'Guest'},'@guest:local'),raw('m.room.power_levels',{users:{[me]:100},events:{}}),raw('m.room.history_visibility',{history_visibility:'joined'})];
    if(kind!=='m.space')events.push(raw('m.room.encryption',{algorithm:'m.megolm.v1.aes-sha2'}));
    if(source)events.push(raw('io.tavern.private_thread.settings',{version:1,title:name,archived:false,autoArchiveSeconds:0}));
    room.currentState.setStateEvents(events.map(value=>new MatrixEvent(value)));room.updateMyMembership(membership as any);room.name=name;room.loadMembersIfNeeded=async()=>{};
    rooms.set(id,room);raws.set(id,events);return room;
  }
  const server=make('!server:local','Server','m.space'),source=make('!source:local','Source'),privateRoom=make('!private:local','Private One','io.tavern.private_thread',parameters.has('invited')?'invite':'join',source.roomId);
  const add=(room:any,type:string,content:any,key='')=>{const event={type,content,state_key:key,room_id:room.roomId,event_id:'$'+type+key,sender:me};raws.get(room.roomId)!.push(event);room.currentState.setStateEvents([new MatrixEvent(event)]);};
  add(server,'io.tavern.roles',defaultRolePolicy(me));add(server,'m.space.child',{via:['local']},source.roomId);add(source,'m.space.parent',{via:['local'],canonical:true},server.roomId);
  const accounts:any={'io.tavern.onboarding':{completed:true},'io.tavern.appearance':{mode:'light'},'io.tavern.text_media':{inlineImages:false}};
  client.getRooms=()=>[...rooms.values()];client.getRoom=(id:string)=>rooms.get(id)||null;client.getAccountData=(type:any)=>accounts[type]?new MatrixEvent({type,content:accounts[type]}):undefined;client.getIgnoredUsers=()=>[];
  client.roomState=async id=>structuredClone(raws.get(id)!) as any;client.getAccountDataFromServer=async(key:any)=>accounts[key]||{};client.setAccountData=async(key:any,value:any)=>{accounts[key]=value;return {} as any;};
  client.fetchRoomEvent=async(roomId,eventId)=>({type:'m.room.encrypted',room_id:roomId,event_id:eventId,content:{},sender:me,origin_server_ts:1000});
  client.joinRoom=async id=>{w.calls.push(['joinRoom',id]);rooms.get(id).updateMyMembership('join');add(rooms.get(id),'m.room.member',{membership:'join',displayname:'Owner'},me);w.notify();return rooms.get(id);};
  client.createRoom=async options=>{w.calls.push(['createRoom',options]);w.syncCreated=()=>{make('!new:local',(options as any).name,'io.tavern.private_thread','join',source.roomId);w.notify();};return {room_id:'!new:local'};};
  const message=(id:string,roomId:string,body:string,attachments:any[]=[])=>({id,body,conversation_id:roomId,conversation_name:rooms.get(roomId)?.name||roomId,author_id:me,author_name:'Owner',created_at:1000,edited_at:null,parent_id:null,pinned:0,saved:0,replies:0,reactions:[],attachments});
  w.publicMessage=message('$source',source.roomId,'Source message',[{id:'public-file',name:'public.txt',size:10}]);
  w.privateMessage=message('$private',privateRoom.roomId,'Private message',[{id:'private-file',name:'secret.txt',size:12}]);
  const messages:any={[source.roomId]:[w.publicMessage],[privateRoom.roomId]:[w.privateMessage]};w.client=client;w.rooms=rooms;w.source=source;
  const bootstrap=()=>({me:{id:me,name:'Owner',role:'member'},workspace:{name:'Tavern'},members:[{id:me,name:'Owner',role:'member'}],memberships:[],preferences:{},preview:false,servers:[{id:server.roomId,name:'Server',roomIds:[source.roomId]}],conversations:[...rooms.values()].filter(room=>!room.isSpaceRoom()&&room.getMyMembership()==='join'&&!isPrivateDiscussion(room)).map(room=>({id:room.roomId,name:room.name,kind:'channel',encrypted:true,unread:0})),invitations:[...rooms.values()].filter(room=>room.getMyMembership()==='invite').map(room=>({id:room.roomId,name:room.name}))});
  w.matrixBoundary=(name:string,args:any[])=>{
    if(name==='getMatrixClient')return client;if(name==='onMatrixUpdate'){w.listeners.add(args[0]);return()=>w.listeners.delete(args[0]);}
    if(name==='matrixStatus')return{connected:true,state:'Connected'};if(name==='matrixTyping')return[];if(name==='restoreMatrixSession')return Promise.resolve(true);
    if(name==='resolveMatrixMessage'){w.resolved.push(args);if(w.deferResolve)return new Promise(resolve=>{w.resolveDelayed=()=>resolve(w.publicMessage);});return Promise.resolve(args[1]==='$older'?message('$older',args[0],'Older private target'):(messages[args[0]]||[]).find((item:any)=>item.id===args[1])||w.publicMessage);}
    if(name==='matrixApi'){const[action,p,params]=args;w.calls.push([action,p,params]);if(action==='bootstrap')return Promise.resolve(bootstrap());if(action==='messages')return Promise.resolve({messages:params?.parent?[]:messages[params?.conversation]||[],hasMore:false});if(action==='saved')return Promise.resolve({messages:[w.privateMessage],hasMore:false});if(action==='send'){(messages[p.conversation]??=[]).push(message('$sent'+w.calls.length,p.conversation,p.body));w.notify();return Promise.resolve({ok:true});}if(action==='read')return Promise.resolve({ok:true});return Promise.resolve({messages:[],hasMore:false});}
    return Promise.resolve();
  };
  w.ready=true;createRoot(document.getElementById('root')!).render(<TooltipProvider><SidebarProvider><Workspace/></SidebarProvider></TooltipProvider>);
}
