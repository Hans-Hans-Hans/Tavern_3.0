import test from 'node:test';import assert from 'node:assert/strict';import {loadTs} from './load-ts.mjs';
const {sharedLocalTime}=loadTs('../lib/time-together.ts',{});
test('time comparison handles DST and preserves unshared or invalid zones as unknown',()=>{
 const winter=sharedLocalTime(Date.parse('2026-01-15T14:00:00Z'),'America/New_York','en-US');
 const summer=sharedLocalTime(Date.parse('2026-07-15T14:00:00Z'),'America/New_York','en-US');
 assert.match(winter.label,/9:00/);assert.match(summer.label,/10:00/);assert.equal(winter.daytime,true);
 assert.equal(sharedLocalTime(Date.parse('2026-01-15T07:00:00Z'),'America/New_York').daytime,false);
 assert.equal(sharedLocalTime(Date.now(),''),null);assert.equal(sharedLocalTime(Date.now(),'Invalid/zone'),null);assert.equal(sharedLocalTime(NaN,'UTC'),null);
});
