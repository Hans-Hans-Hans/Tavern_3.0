import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';
const {sectionConversations,sectionForConversation}=loadTs('../lib/conversation-navigation.ts',{});
const rooms=[{id:'dm',kind:'dm'},{id:'group',kind:'dm'},{id:'a',kind:'channel'},{id:'b',kind:'private'},{id:'loose',kind:'channel'}];
const servers=[{id:'server-a',roomIds:['a']},{id:'server-b',roomIds:['b']}];
test('DM and channel inventories stay separate, including group messages',()=>{
 assert.deepEqual(sectionConversations(rooms,servers,'dms').map(r=>r.id),['dm','group']);
 assert.deepEqual(sectionConversations(rooms,servers,'all').map(r=>r.id),['a','b','loose']);
 assert.deepEqual(sectionConversations(rooms,servers,'server-b').map(r=>r.id),['b']);
 assert.deepEqual(sectionConversations([],servers,'dms'),[]);
});
test('deep links and navigation select the owning section without losing a shared-room server',()=>{
 assert.equal(sectionForConversation(rooms,servers,'server-a','dm'),'dms');
 assert.equal(sectionForConversation(rooms,servers,'dms','b'),'server-b');
 assert.equal(sectionForConversation(rooms,servers,'server-b','loose'),'all');
 assert.equal(sectionForConversation(rooms,servers,'dms','pending'),'dms');
 assert.equal(sectionForConversation(rooms,[...servers,{id:'shared',roomIds:['a']}],'shared','a'),'shared');
});
