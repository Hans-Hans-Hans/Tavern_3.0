import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';
const {normalizeServerOnboarding,recommendedChannels}=loadTs('../lib/server-onboarding.ts',{'./matrix':{},'./community':{},'./roles':{}});
test('server onboarding bounds recommendations and strips malformed choices',()=>{
  const value=normalizeServerOnboarding({enabled:true,startChannel:'https://evil.test',recommended:['!a:local','!a:local','invalid'],interests:[{id:'games',label:'Games',channels:['!b:local']},{id:'games',label:'Duplicate',channels:['!c:local']},{id:'../../bad',label:'Invalid'}]});
  assert.equal(value.startChannel,'');assert.deepEqual(value.recommended,['!a:local']);assert.equal(value.interests.length,1);
  assert.deepEqual(recommendedChannels(value,['games','nonexistent']),['!a:local','!b:local']);
});
