import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';
const model=loadTs('../lib/sticker-model.ts',{});
const sticker={id:'cat',name:'Wave',alt:'A cat waving hello',url:'mxc://local/artwork'};
test('stickers accept bounded community artwork and reject scripts, missing alternatives and duplicate identities',()=>{
 assert.deepEqual(model.parseSticker(sticker),sticker);
 for(const change of [{url:'https://tracker.test/cat.png'},{url:'data:image/svg+xml,script'},{alt:''},{id:'../cat'},{name:'x'.repeat(61)}])assert.equal(model.parseSticker({...sticker,...change}),null);
 assert.equal(model.parseStickerPack('pack',{version:1,name:'Cats',stickers:[sticker,sticker]}),null);
 assert.equal(model.parseStickerPack('pack',{version:1,name:'Cats',stickers:[sticker],deleted:true}),null);
 assert.deepEqual(model.parseStickerPack('pack',{version:1,name:'Cats',stickers:[sticker]}),{id:'pack',name:'Cats',stickers:[sticker]});
});
test('sticker writes recheck account and permissions after native state reads and preserve concurrency receipts',async()=>{
 const account={},client={getUserId:()=> '@owner:local',getDeviceId:()=> 'device',getRoom:()=>room,roomState:async()=>[],sendStateEvent:async(...args)=>writes.push(args)},writes=[];
 const room={isSpaceRoom:()=>true,getMyMembership:()=> 'join',currentState:{maySendStateEvent:()=>true}};
 let active=client;
 const library=loadTs('../lib/stickers.ts',{'./matrix':{getMatrixClient:()=>active},'./api':{accountArtworkOwner:()=>account},'./community':{},'./roles':{readRolePolicy:()=>null},'./sticker-model':model});
 const pack={id:'pack',name:'Cats',stickers:[sticker]};
 await library.saveStickerPack('!server:local',pack,null);assert.equal(writes[0][2]['io.tavern.previous_event'],null);
 client.roomState=async()=>{active=null;return [];};await assert.rejects(library.saveStickerPack('!server:local',pack,null),/account or server permissions changed/);assert.equal(writes.length,1);
 active=client;client.roomState=async()=>[{type:model.stickerEvent,state_key:'pack',event_id:'$new',content:{version:1,...pack,name:'Someone renamed this'}}];
 await assert.rejects(library.saveStickerPack('!server:local',pack,pack),/pack changed/);assert.equal(writes.length,1);
});
