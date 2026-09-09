import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';
const {firstUnreadMessage,parseConversationLink}=loadTs('../lib/message-navigation.ts',{});
test('unread anchor starts after receipt and skips own messages',()=>{
  const messages=[{id:'read',author_id:'peer'},{id:'mine',author_id:'me'},{id:'new',author_id:'peer'}];
  assert.equal(firstUnreadMessage(messages,'read','me',true),'new');
  assert.equal(firstUnreadMessage(messages,'new','me',true),null);
  assert.equal(firstUnreadMessage(messages,null,'me',false),null);
});
test('conversation links preserve encoded Matrix identifiers and reject unsafe IDs',()=>{
  assert.deepEqual(parseConversationLink('#room=%21room%3Aexample.test&event=%24event%2Fid'),{roomId:'!room:example.test',eventId:'$event/id'});
  assert.deepEqual(parseConversationLink('#room=https%3A%2F%2Fevil.test&event=bad'),{roomId:'',eventId:''});
});
