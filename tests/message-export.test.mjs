import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';
function fixture(pages){let index=0,active;const requests=[],room={name:'Room',getMyMembership:()=> 'join',hasEncryptionStateEvent:()=> true};const client={getUserId:()=> '@me:local',getDeviceId:()=> 'EXPORT_DEVICE',getRoom:()=>room,createMessagesRequest:async(_room,token)=>{requests.push(token);return pages[index++];},decryptEventIfNeeded:async event=>{event.clear=event.raw.plain;},getEventMapper:()=>raw=>({raw,isEncrypted:()=>raw.type==='m.room.encrypted',isDecryptionFailure(){return raw.type==='m.room.encrypted'&&!this.clear;},getType(){return this.clear?'m.room.message':raw.type;},getOriginalContent(){return this.clear||raw.content;},getSender:()=>raw.sender,getId:()=>raw.event_id,getTs:()=>raw.origin_server_ts,isRedacted:()=>!!raw.redacted})};active=client;const module=loadTs('../lib/message-export.ts',{'matrix-js-sdk':{Direction:{Backward:'b'}},'./matrix':{getMatrixClient:()=>active}});return {client,room,requests,...module,switchAccount:()=>active=null};}
const event=(id,sender='@me:local',extra={})=>({event_id:id,sender,origin_server_ts:100,type:'m.room.message',content:{msgtype:'m.text',body:id},...extra});
test('historical export decrypts all pages, keeps edits, omits other authors and records missing keys',async()=>{
 const f=fixture([{chunk:[event('$encrypted',undefined,{type:'m.room.encrypted',plain:{body:'decrypted'}}),event('$peer','@peer:local')],end:'older'},{chunk:[event('$edit',undefined,{content:{body:'edit','m.relates_to':{rel_type:'m.replace',event_id:'$encrypted'}}}),event('$missing',undefined,{type:'m.room.encrypted'})]}]);const lines=[];const result=await f.exportMessageHistory(f.client,['!room:local'],true,async line=>lines.push(JSON.parse(line)),()=>{},new AbortController().signal);
 assert.equal(result.exported,2);assert.equal(result.undecryptable,1);assert.equal(result.roomsDone,1);assert.equal(lines.find(x=>x.eventId==='$encrypted').content.body,'decrypted');assert.equal(lines.find(x=>x.eventId==='$edit').content['m.relates_to'].event_id,'$encrypted');assert.equal(lines.some(x=>x.eventId==='$peer'),false);assert.equal(lines.at(-1).type,'complete');
});
test('export cancellation, account changes and repeated cursors never claim completion',async()=>{
 const f=fixture([{chunk:[event('$1')],end:'repeat'},{chunk:[event('$2')],end:'repeat'}]);const lines=[];await assert.rejects(f.exportMessageHistory(f.client,['!room:local'],true,async line=>lines.push(JSON.parse(line)),()=>{},new AbortController().signal),/stopped advancing/);assert.equal(lines.some(x=>x.type==='complete'),false);
 const canceled=new AbortController();canceled.abort();await assert.rejects(f.exportMessageHistory(f.client,[],true,async()=>{},()=>{},canceled.signal),{name:'AbortError'});
 f.switchAccount();await assert.rejects(f.exportMessageHistory(f.client,[],true,async()=>{},()=>{},new AbortController().signal),/account changed/);
});

test('empty filtered pages advance to older readable history instead of completing early', async () => {
 const f=fixture([{chunk:[],end:'filtered'},{chunk:[],end:'older'},{chunk:[event('$old',undefined,{type:'m.room.encrypted',plain:{body:'Earlier readable secret'}})]}]);
 const lines=[];
 const result=await f.exportMessageHistory(f.client,['!room:local'],false,async line=>lines.push(JSON.parse(line)),()=>{},new AbortController().signal);
 assert.deepEqual(f.requests,[null,'filtered','older']);assert.equal(result.exported,1);assert.equal(lines.find(row=>row.eventId==='$old').content.body,'Earlier readable secret');assert.equal(lines.at(-1).type,'complete');
});

test('cyclic empty history pages, invalid tokens and conflicting room identities never claim complete exports', async () => {
 for(const pages of [
  [{chunk:[],end:'one'},{chunk:[],end:'two'},{chunk:[],end:'one'}],
  [{chunk:[],end:null}], [{chunk:[],end:''}], [{chunk:[],end:5}],
  [{chunk:[event('$other',undefined,{room_id:'!other:local'})]}],
 ]) {
  const f=fixture(pages),lines=[];
  await assert.rejects(f.exportMessageHistory(f.client,['!room:local'],false,async line=>lines.push(JSON.parse(line)),()=>{},new AbortController().signal),/stopped advancing|unexpected conversation/);
  assert.equal(lines.some(row=>row.type==='complete'),false);assert.equal(lines.some(row=>row.type==='event'),false);
 }
});

test('membership, actor or device replacement while a history page is pending stops plaintext output', async () => {
 for(const change of [f=>f.room.getMyMembership=()=> 'leave',f=>f.client.getRoom=()=>({...f.room}),f=>f.client.getUserId=()=> '@other:local',f=>f.client.getDeviceId=()=> 'OTHER_DEVICE']) {
  const f=fixture([]),lines=[];
  f.client.createMessagesRequest=async()=>{change(f);return {chunk:[event('$private')]};};
  await assert.rejects(f.exportMessageHistory(f.client,['!room:local'],false,async line=>lines.push(JSON.parse(line)),()=>{},new AbortController().signal),/account changed|membership changed/);
  assert.equal(lines.some(row=>row.type==='event'||row.type==='complete'),false);
 }
});

test('membership lost during decryption stops before writing the decrypted event', async () => {
 const f=fixture([{chunk:[event('$encrypted',undefined,{type:'m.room.encrypted',plain:{body:'Secret'}})]}]),lines=[];
 const decrypt=f.client.decryptEventIfNeeded;
 f.client.decryptEventIfNeeded=async event=>{await decrypt(event);f.room.getMyMembership=()=> 'leave';};
 await assert.rejects(f.exportMessageHistory(f.client,['!room:local'],false,async line=>lines.push(JSON.parse(line)),()=>{},new AbortController().signal),/membership changed/);
 assert.equal(lines.some(row=>row.type==='event'||row.type==='complete'),false);
});
