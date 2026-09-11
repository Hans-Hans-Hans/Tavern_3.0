import React from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, MatrixEvent, Room, NotificationCountType } from 'matrix-js-sdk';
import { Toaster } from 'sonner';
import { ServerNavigation } from '../../../app/server-navigation';
import { MobileServerNavigation } from '../../../app/mobile-server-navigation';
import { ActionMenu } from '../../../app/action-menu';
import '../../../app/globals.css';
import '../../../app/product.css';
import '../../../app/community.css';
export function mountFixture(mobile=false) {
  const w=window as any;w.accountOwner={};w.listeners=[];w.selected=[];w.saved=[];w.actor='@owner:local';w.device='DEVICE';
  const initial={version:1,folders:[{id:'games',name:'Games',color:'#123456',serverIds:['!charlie:local']},{id:'work',name:'Work',color:'#654321',serverIds:['!delta:local']}],order:['!alpha:local','!bravo:local','!charlie:local','!delta:local'],collapsed:[]};
  w.native=JSON.parse(sessionStorage.getItem('fixture-server-organization')||'null')||initial;w.cache=structuredClone(w.native);
  const updateCache=()=>{w.cache=structuredClone(w.native);w.client.store.storeAccountDataEvents([new MatrixEvent({type:'io.tavern.server_folders',content:w.cache})]);w.listeners.forEach((fn:()=>void)=>fn());};
  w.client=createClient({baseUrl:location.origin+'/api/matrix',userId:w.actor,deviceId:w.device,accessToken:'fixture-token',fetchFn:async(url,options)=>{
    const pathname=new URL(String(url)).pathname;if(!pathname.endsWith('/account_data/io.tavern.server_folders'))throw Error('Unexpected native request');
    if(options?.method==='PUT') { if(w.holdWrite)await new Promise<void>(resolve=>w.releaseWrite=resolve);if(w.failWrite){w.failWrite=false;return new Response(JSON.stringify({errcode:'M_FORBIDDEN',error:'Fixture save denied'}),{status:403,headers:{'Content-Type':'application/json'}});}w.native=JSON.parse(options.body as string);w.saved.push(structuredClone(w.native));sessionStorage.setItem('fixture-server-organization',JSON.stringify(w.native));updateCache(); }
    else if(w.holdRead)await new Promise<void>(resolve=>w.releaseRead=resolve);
    return new Response(JSON.stringify(options?.method==='PUT'?{}:w.native),{status:200,headers:{'Content-Type':'application/json'}});
  }});
  updateCache();
  w.sync=(value:any)=>{w.native=structuredClone(value);sessionStorage.setItem('fixture-server-organization',JSON.stringify(value));updateCache();};
  w.changeOwner=()=>{w.accountOwner={};w.holdRead=false;w.listeners.forEach((fn:()=>void)=>fn());};
  const servers=[{id:'!alpha:local',name:'Alpha'},{id:'!bravo:local',name:'Bravo'},{id:'!charlie:local',name:'Charlie'},{id:'!delta:local',name:'Delta'}];
  w.manualUnread=[]; w.readState={roomIds:['!child:local','!muted:local','!left:local','!invited:local','!manual:local'],muted:['!muted:local'],focus:false};
  let eventNumber=0;
  const stateEvent=(id:string,type:string,key:string,content:any)=>new MatrixEvent({room_id:id,type,state_key:key,content,event_id:'$read'+(++eventNumber),sender:w.actor});
  const addRoom=(id:string,space=false,membership='join',unread=0,mentions=0)=>{
    const room=new Room(id,w.client,w.actor,{pendingEventOrdering:'detached'});room.updateMyMembership(membership as any);
    room.currentState.setStateEvents([stateEvent(id,'m.room.create','',space?{type:'m.space'}:{})]);
    room.setUnreadNotificationCount(NotificationCountType.Total,unread);room.setUnreadNotificationCount(NotificationCountType.Highlight,mentions);w.client.store.storeRoom(room);return room;
  };
  for(const server of servers)addRoom(server.id,true);
  addRoom('!child:local',false,'join',3,2);addRoom('!muted:local',false,'join',90,70);addRoom('!left:local',false,'leave',50,30);addRoom('!invited:local',false,'invite',40,20);addRoom('!hidden:local',false,'join',60,40);addRoom('!manual:local');
  w.client.getRoom('!alpha:local').currentState.setStateEvents([...w.readState.roomIds,'!hidden:local'].map((id:string)=>stateEvent('!alpha:local','m.space.child',id,{via:['local']})));
  w.client.getRoom('!bravo:local').currentState.setStateEvents([stateEvent('!bravo:local','m.space.child','!manual:local',{via:['local']})]);
  w.emit=()=>w.listeners.forEach((fn:()=>void)=>fn());
  const root=createRoot(document.getElementById('root')!);w.redraw=()=>root.render(<React.StrictMode>{mobile ? <div style={{width:'100%',padding:12}}><MobileServerNavigation servers={servers} readState={w.readState} active='' onSelectServer={id=>w.selected.push(id)} serverActions={server=>[{label:'Server settings '+server.name,run:()=>w.selected.push('settings:'+server.id)}]}/></div> : <aside className='workspace-rail' style={{height:'100dvh',display:'flex'}}><ServerNavigation servers={servers} readState={w.readState} active='' onSelectServer={id=>w.selected.push(id)} renderServer={(server,button,organization)=><ActionMenu actions={[{label:'Server settings '+server.name,run:()=>{}},...organization]}>{button}</ActionMenu>}/></aside>}<Toaster/></React.StrictMode>);w.redraw();
}
