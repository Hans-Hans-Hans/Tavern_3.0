import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const {projectWork,pollClosed,pollSelections}=loadTs('../lib/collaboration.ts',{'matrix-js-sdk':{Direction:{Backward:'b'}},'./matrix':{}});
const event=(id,sender,at,p)=>({getId:()=>id,getSender:()=>sender,getTs:()=>at,isEncrypted:()=>true,isRedacted:()=>false,isDecryptionFailure:()=>false,getContent:()=>({'io.tavern.collaboration':{version:1,...p}})});
test('a member cannot rewrite another author’s note',()=>{const events=[event('root','alice',1,{operation:'create',kind:'note',title:'Original'}),event('attack','mallory',2,{operation:'edit',root:'root',revision:'root',title:'Replaced'})];assert.equal(projectWork(events)[0].title,'Original');});
test('concurrent stale revisions do not overwrite an accepted edit',()=>{const events=[event('root','alice',1,{operation:'create',kind:'note',title:'First'}),event('a','alice',2,{operation:'edit',root:'root',revision:'root',title:'Accepted'}),event('b','alice',3,{operation:'edit',root:'root',revision:'root',title:'Stale'})];assert.equal(projectWork(events)[0].title,'Accepted');});
test('assignee can progress a task but cannot rewrite its text',()=>{const events=[event('root','alice',1,{operation:'create',kind:'task',title:'Build',assignee:'bob'}),event('done','bob',2,{operation:'status',root:'root',revision:'root',status:'done'}),event('bad','bob',3,{operation:'edit',root:'root',revision:'done',title:'Changed'})];const item=projectWork(events)[0];assert.equal(item.status,'done');assert.equal(item.title,'Build');});
test('poll changes vote once per sender and rejects post-close votes',()=>{const events=[event('root','alice',1,{operation:'create',kind:'poll',title:'Choose',options:['A','B']}),event('v1','bob',2,{operation:'vote',root:'root',choice:0}),event('v2','bob',3,{operation:'vote',root:'root',choice:1}),event('end','alice',4,{operation:'close',root:'root',revision:'root'}),event('late','bob',5,{operation:'vote',root:'root',choice:0})];assert.deepEqual(projectWork(events)[0].votes,{bob:1});});

test('multiple-choice ballots replace atomically, deduplicate, and ignore invalid votes',()=>{
  const events=[event('root','alice',1,{operation:'create',kind:'poll',title:'Choose',multiple:true,options:['A','B','C']}),event('v1','bob',2,{operation:'vote',root:'root',choices:[0,1,1]}),event('v2','bob',3,{operation:'vote',root:'root',choices:[1,2]}),event('bad','bob',4,{operation:'vote',root:'root',choices:[99]})];
  const poll=projectWork(events)[0];assert.deepEqual(pollSelections(poll,'bob'),[1,2]);assert.deepEqual(pollSelections(poll,'alice'),[]);
  assert.deepEqual(projectWork([...events,event('clear','bob',5,{operation:'vote',root:'root',choices:[]})])[0].votes,{});
});

test('expiration preserves earlier votes and ignores ballots at or after the deadline',()=>{
  const poll=projectWork([event('root','alice',1,{operation:'create',kind:'poll',title:'Choose',closesAt:10,options:['A','B']}),event('valid','bob',9,{operation:'vote',root:'root',choice:0}),event('late','bob',10,{operation:'vote',root:'root',choice:1}),event('invalid','mallory',8,{operation:'vote',root:'root',choices:[0,1]})])[0];
  assert.deepEqual(poll.votes,{bob:0});assert.equal(pollClosed(poll,9),false);assert.equal(pollClosed(poll,10),true);
});
