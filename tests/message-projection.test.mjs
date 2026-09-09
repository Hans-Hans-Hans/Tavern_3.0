import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';
const {indexReactions}=loadTs('../lib/message-projection.ts',{});
const event=(user,key,id='$one',redacted=false)=>({getType:()=> 'm.reaction',isRedacted:()=>redacted,getSender:()=>user,getContent:()=>({'m.relates_to':{rel_type:'m.annotation',event_id:id,key}})});
test('reaction projection deduplicates senders and ignores redacted/invalid reactions',()=>{
  const r=indexReactions([event('@a:x','👍'),event('@a:x','👍'),event('@b:x','👍'),event('@c:x','👍','$one',true),event('@a:x','x'.repeat(31)),event('@a:x','mxc://local/emoji')],'@a:x');
  assert.deepEqual(r.get('$one'),[{emoji:'👍',count:2,mine:1,users:['@a:x','@b:x']},{emoji:'mxc://local/emoji',count:1,mine:1,users:['@a:x']}]);
});
test('independent room event IDs remain separate in the projection',()=>{
  const r=indexReactions([event('@a:x','👍','$one'),event('@b:x','👍','$two')],'@a:x');assert.equal(r.get('$one')[0].mine,1);assert.equal(r.get('$two')[0].mine,0);
});
