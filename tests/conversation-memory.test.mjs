import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const model=loadTs('../lib/conversation-memory.ts',{});
function storage(){const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};}
test('conversation memory is separate per account and section, preserving landing preference',()=>{
 const store=storage();model.saveConversationMemory('alice',{section:'!server:local',roomId:'!second:local',landing:'home'},store);
 model.saveConversationMemory('alice',{section:'dms',roomId:'!friend:local'},store);
 assert.equal(model.readConversationMemory('bob',store).section,'all');
 const value=model.readConversationMemory('alice',store);
 assert.equal(value.landing,'home');assert.equal(value.rooms['!server:local'],'!second:local');assert.equal(value.rooms.dms,'!friend:local');
 const rooms=[{id:'!first:local',kind:'text'},{id:'!second:local',kind:'text'},{id:'!friend:local',kind:'dm'}],servers=[{id:'!server:local',roomIds:['!first:local','!second:local']}];
 assert.equal(model.rememberedConversation(value,'!server:local',rooms,servers).id,'!second:local');
 assert.equal(model.rememberedConversation(value,'dms',rooms,servers).id,'!friend:local');
 assert.equal(model.rememberedConversation(value,'!server:local',rooms.filter(r=>r.id!=='!second:local'),servers).id,'!first:local');
 assert.equal(model.rememberedConversation(value,'dms',rooms.filter(r=>r.kind!=='dm'),servers),undefined);
});
test('invalid or unavailable storage does not prevent navigation',()=>{
 assert.equal(model.readConversationMemory('alice',{getItem:()=>'{broken'}).section,'all');
 const unavailable={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('full');}};
 assert.doesNotThrow(()=>model.saveConversationMemory('alice',{roomId:'!room:local'},unavailable));
 const store=storage();store.setItem('tavern.navigation.v1:alice',JSON.stringify({section:'javascript:alert(1)',rooms:{all:'https://elsewhere'},landing:'elsewhere'}));
 assert.deepEqual(model.readConversationMemory('alice',store),{section:'all',rooms:{},landing:'last'});
});
