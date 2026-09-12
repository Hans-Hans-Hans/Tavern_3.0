import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';
test('personal server colors are explicit, bounded and merge without replacing other preferences',async()=>{
 let saved={version:1,colors:{'!one:local':'blue'}};
 const owner={},client={getRoom:()=>({isSpaceRoom:()=>true,getMyMembership:()=> 'join'})};
 const model=loadTs('../lib/server-personalization.ts',{'./api':{accountArtworkOwner:()=>owner},'./matrix':{getMatrixClient:()=>client,mutateMatrixAccountData:async(client,key,update,check)=>{check();saved=update(saved);}}});
 assert.deepEqual(model.normalizePersonalServers({colors:{'!good:local':'rose','!bad:local':'url(script)','bad':'blue'}}),{'!good:local':'rose'});
 await model.savePersonalServer('!two:local','gold');assert.deepEqual(saved.colors,{'!one:local':'blue','!two:local':'gold'});
 await model.savePersonalServer('!one:local','');assert.deepEqual(saved.colors,{'!two:local':'gold'});
 await assert.rejects(model.savePersonalServer('!one:local','invalid'),/available colors/);
});
