import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { loadTs } from './load-ts.mjs';
const { sendMatrixTransaction: send } = loadTs('../lib/send-matrix-transaction.ts', {});
function fixture(encrypted=false) {
  const state={fail:true,current:true,encryptions:0,gate:null},requests=[];
  const client=createClient({baseUrl:'https://outbox-sdk.local',userId:'@sender:local',deviceId:'DEVICE',accessToken:'fixture-only',timelineSupport:true,fetchFn:async(url,options)=>{
    requests.push({path:new URL(String(url)).pathname,body:JSON.parse(options.body)});
    if(state.gate)await state.gate;
    return new Response(JSON.stringify(state.fail?{errcode:'M_FORBIDDEN',error:'Fixture unconfirmed send'}:{event_id:state.eventId??'$ack'}),{status:state.fail?403:200,headers:{'Content-Type':'application/json'}});
  }});
  const room=new Room('!outbox:local',client,'@sender:local',{pendingEventOrdering:'chronological'});client.store.storeRoom(room);room.updateMyMembership('join');
  if(encrypted){
    room.currentState.setStateEvents([new MatrixEvent({type:'m.room.encryption',state_key:'',content:{algorithm:'m.megolm.v1.aes-sha2'},sender:'@sender:local',event_id:'$encryption',room_id:room.roomId})]);
    // The SDK lifecycle and MatrixEvent clear/wire transition are real. This
    // synthetic crypto boundary tests ciphertext reuse, not Megolm itself.
    client.cryptoBackend={encryptEvent:async event=>{state.encryptions++;event.makeEncrypted('m.room.encrypted',{algorithm:'m.megolm.v1.aes-sha2',ciphertext:'fixture-'+state.encryptions},'fixture-curve','fixture-ed');}};
  }
  return {client,room,state,requests,current:()=>state.current};
}
test('actual SDK retries its existing chronological local echo and transaction after unconfirmed HTTP',async()=>{
  const f=fixture(),content={msgtype:'m.text',body:'Original text','m.mentions':{user_ids:[]}};
  await assert.rejects(send(f.client,f.room,content,'stable',undefined,f.current),/Fixture/);
  const event=f.room.getEventForTxnId('stable');assert.equal(event.status,'not_sent');assert.throws(()=>f.room.getPendingEvents(),/chronological/);
  f.state.fail=false;assert.deepEqual(await send(f.client,f.room,content,'stable',undefined,f.current),{event_id:'$ack'});
  assert.equal(f.room.getEventForTxnId('stable'),event);assert.equal(event.status,'sent');
  assert.equal(f.requests.length,2);assert.equal(f.requests[0].path,f.requests[1].path);
  await send(f.client,f.room,content,'stable',undefined,f.current);assert.equal(f.requests.length,2,'a known ACK is not sent again');
});
test('actual encrypted local echo retains original clear content and exact ciphertext on SDK resend',async()=>{
  const f=fixture(true),content={msgtype:'m.file',body:'secret.txt',filename:'secret.txt',file:{url:'mxc://local/ciphertext',key:{k:'fixture'}},info:{size:3}};
  await assert.rejects(send(f.client,f.room,content,'encrypted-file',undefined,f.current),/Fixture/);
  const event=f.room.getEventForTxnId('encrypted-file');assert.equal(event.getWireType(),'m.room.encrypted');assert.equal(event.getType(),'m.room.message');assert.deepEqual(event.getContent(),content);
  f.state.fail=false;await send(f.client,f.room,content,'encrypted-file',undefined,f.current);
  assert.equal(f.state.encryptions,1);assert.deepEqual(f.requests[1],f.requests[0]);assert.equal(f.room.getLiveTimeline().getEvents().filter(value=>value===event).length,1);
});
test('actual local echo rejects changed content, target thread, sender and in-flight duplication',async()=>{
  const f=fixture(),content={msgtype:'m.text',body:'Original'};
  await assert.rejects(send(f.client,f.room,content,'stable',undefined,f.current));
  await assert.rejects(send(f.client,f.room,{...content,body:'Changed'},'stable',undefined,f.current),/another message/);
  await assert.rejects(send(f.client,f.room,content,'stable','$thread',f.current),/another message/);
  const actor=f.client.getUserId;f.client.getUserId=()=> '@other:local';await assert.rejects(send(f.client,f.room,content,'stable',undefined,f.current),/another message/);f.client.getUserId=actor;
  let release;f.state.gate=new Promise(resolve=>release=resolve);f.state.fail=false;
  const pending=send(f.client,f.room,content,'stable',undefined,f.current);await Promise.resolve();
  await assert.rejects(send(f.client,f.room,content,'stable',undefined,f.current),/still being sent/);release();await pending;
  f.state.current=false;await assert.rejects(send(f.client,f.room,content,'stable',undefined,f.current),/account or conversation/);
});
test('malformed successful SDK responses never become acknowledged direct or cached sends',async()=>{
  for(const eventId of ['not-an-event','$','$bad id','$'+ 'x'.repeat(1024)]){
    const f=fixture();f.state.fail=false;f.state.eventId=eventId;const content={msgtype:'m.text',body:'Keep original draft'};
    await assert.rejects(send(f.client,f.room,content,'invalid-ack',undefined,f.current),/invalid message acknowledgement/);
    const event=f.room.getEventForTxnId('invalid-ack');assert.equal(event.status,'sent','the actual SDK accepted this invalid HTTP response');assert.deepEqual(event.getContent(),content);
    await assert.rejects(send(f.client,f.room,content,'invalid-ack',undefined,f.current),/invalid message acknowledgement/);assert.equal(f.requests.length,1);
  }
});
