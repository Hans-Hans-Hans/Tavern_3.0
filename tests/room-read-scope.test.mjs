import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { readJoinedRoom }=loadTs('../lib/room-read-scope.ts',{});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
function fixture(){let member='join',active=true;const room={roomId:'!private:local',getMyMembership:()=>member};let currentRoom=room;const client={getRoom:()=>currentRoom};return{room,client,current:()=>active,switchAccount:()=>{active=false;},leave:()=>{member='leave';},replaceRoom:()=>{currentRoom={...room};}};}

test('a completed decryption cannot populate the next account cache or publish revoked-room messages',async()=>{
  for(const change of ['switchAccount','leave','replaceRoom']){
    const f=fixture(),gate=deferred(),cache=new Map();
    const pending=readJoinedRoom(f.client,f.room,f.current,()=>gate.promise,events=>{events.forEach(event=>cache.set(event.id,event));return events;});
    f[change]();gate.resolve([{id:'$old',body:'Previous account private text'}]);
    await assert.rejects(pending,/account or room access changed/);assert.equal(cache.size,0,change);
  }
});
test('existing access is required before reads and current completed reads project once',async()=>{
  const f=fixture();let reads=0,projects=0;
  const read=async()=>{reads++;return['message'];},project=value=>{projects++;return value;};
  assert.deepEqual(await readJoinedRoom(f.client,f.room,f.current,read,project),['message']);
  assert.equal(reads,1);assert.equal(projects,1);f.leave();
  await assert.rejects(readJoinedRoom(f.client,f.room,f.current,read,project),/room access changed/);
  assert.equal(reads,1);assert.equal(projects,1);
});
test('a rejected native read cannot publish cached results',async()=>{
  const f=fixture();let published=false;
  await assert.rejects(readJoinedRoom(f.client,f.room,f.current,async()=>{throw new Error('Native read denied');},()=>{published=true;}),/Native read denied/);
  assert.equal(published,false);
});
