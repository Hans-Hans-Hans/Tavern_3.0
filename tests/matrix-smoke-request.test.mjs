import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matrixSmokeRequest } from '../scripts/matrix-smoke-request.mjs';
const limited=delay=>({status:429,data:{errcode:'M_LIMIT_EXCEEDED',retry_after_ms:delay}});
test('live native probes respect the reported retry delay before retrying a rejected request',async()=>{
  let calls=0;const delays=[],success={status:200,data:{event_id:'$archived'}};
  assert.equal(await matrixSmokeRequest(async()=>++calls===1?limited(2276):success,async delay=>delays.push(delay)),success);
  assert.equal(calls,2);assert.deepEqual(delays,[2376]);
});
test('ambiguous native failures and non-rate-limit errors are never replayed',async()=>{
  for(const response of [{status:403,data:{errcode:'M_FORBIDDEN'}},{status:500,data:{}},{status:429,data:{errcode:'OTHER',retry_after_ms:1}},limited(-1),limited(Infinity),limited(30001),limited('1')]){
    let calls=0;assert.equal(await matrixSmokeRequest(async()=>{calls++;return response;},async()=>assert.fail('Must not wait')),response);assert.equal(calls,1);
  }
  let calls=0;await assert.rejects(matrixSmokeRequest(async()=>{calls++;throw new Error('Network outcome unknown');}),/outcome unknown/);assert.equal(calls,1);
});
test('rate-limit retries are bounded and return persistent rejection to the assertion',async()=>{
  let calls=0;const delays=[],response=limited(0);
  assert.equal(await matrixSmokeRequest(async()=>{calls++;return response;},async delay=>delays.push(delay)),response);
  assert.equal(calls,5);assert.deepEqual(delays,[100,100,100,100]);
});
