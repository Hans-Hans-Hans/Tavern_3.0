import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matrixSmokeJoin, matrixSmokeLeave, matrixSmokeRequest, matrixSmokeCreateFixture, matrixSmokeInvite } from '../scripts/matrix-smoke-request.mjs';
const limited=delay=>({status:429,data:{errcode:'M_LIMIT_EXCEEDED',retry_after_ms:delay}});

const fixture = () => ({ name: 'CI isolated creation', visibility: 'private', preset: 'private_chat', creation_content: { 'm.federate': false }, initial_state: [] });
test('only empty private CI creation retries a confirmed rate limit and keeps its exact configuration', async () => {
  const config = fixture(), calls = [], delays = [], created = { status: 200, data: { room_id: '!new:local' } };
  const result = await matrixSmokeCreateFixture(async body => {
    calls.push(structuredClone(body)); body.invite = ['@unintended:local']; config.name = 'Changed by caller';
    return calls.length === 1 ? limited(3200) : created;
  }, config, async delay => delays.push(delay));
  assert.equal(result, created); assert.deepEqual(calls, [fixture(), fixture()]); assert.deepEqual(delays, [3300]);
});
test('creation with invitation or arbitrary state side effects is rejected before a request', async () => {
  for (const extra of [{ invite: [] }, { invite: ['@person:local'] }, { invite_3pid: [] }, { is_direct: true },
    { initial_state: [{ type: 'm.room.member', content: { membership: 'invite' } }] }, { visibility: 'public' },
    { creation_content: { 'm.federate': true } }, { name: 'Existing production room' }, { room_alias_name: 'existing' }]) {
    await assert.rejects(matrixSmokeCreateFixture(async () => assert.fail('Must not create'), { ...fixture(), ...extra }), /without invitation side effects/);
  }
});
test('ambiguous room creation failures are not replayed', async () => {
  let calls = 0;
  await assert.rejects(matrixSmokeCreateFixture(async () => { calls++; throw new Error('Unknown outcome'); }, fixture()), /Unknown outcome/);
  assert.equal(calls, 1);
  for (const response of [{ status: 500, data: {} }, { status: 429, data: { errcode: 'OTHER' } }]) {
    calls = 0;
    assert.equal(await matrixSmokeCreateFixture(async () => { calls++; return response; }, fixture()), response);
    assert.equal(calls, 1);
  }
});
test('an invitation rechecks a known target and never replays a partially applied invitation', async () => {
  let reads = 0, invites = 0;
  const invited = { status: 200, data: { membership: 'invite' } };
  assert.equal(await matrixSmokeInvite(async () => ++reads === 1 ? { status: 404, data: { errcode: 'M_NOT_FOUND' } } : invited,
    async () => { invites++; return limited(10); }, async () => {}), invited);
  assert.equal(reads, 2); assert.equal(invites, 1);
  for (const membership of ['invite', 'join']) {
    await matrixSmokeInvite(async () => ({ status: 200, data: { membership } }), async () => assert.fail('Already admitted'));
  }
});
test('unavailable or unexpected native membership and ambiguous errors never replay invitations', async () => {
  for (const response of [{ status: 403, data: {} }, { status: 502, data: {} }, { status: 404, data: { errcode: 'OTHER' } }]) {
    assert.equal(await matrixSmokeInvite(async () => response, async () => assert.fail('Cannot confirm target')), response);
  }
  await assert.rejects(matrixSmokeInvite(async () => ({ status: 200, data: { membership: 'ban' } }), async () => assert.fail('Banned')), /unexpected native membership/);
  let calls = 0;
  await assert.rejects(matrixSmokeInvite(async () => ({ status: 200, data: { membership: 'leave' } }),
    async () => { calls++; throw new Error('Unknown invitation outcome'); }), /Unknown invitation outcome/);
  assert.equal(calls, 1);
});
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

test('a rate-limited known-room join rechecks membership before attempting it again', async () => {
  let reads = 0, joins = 0;
  const success = {status:200,data:{room_id:'!known:local'}};
  assert.equal(await matrixSmokeJoin(async () => {reads++;return {status:403,data:{}};}, async () => ++joins === 1 ? limited(3408) : success, async () => {}), success);
  assert.equal(reads,2); assert.equal(joins,2);
});

test('a partially applied join stops at confirmed membership without replay', async () => {
  let reads = 0, joins = 0;
  const joined = {status:200,data:{membership:'join'}};
  assert.equal(await matrixSmokeJoin(async () => ++reads === 1 ? {status:404,data:{}} : joined, async () => {joins++;return limited(1);}, async () => {}), joined);
  assert.equal(reads,2); assert.equal(joins,1);
});

test('unavailable membership and ambiguous join errors do not submit another join', async () => {
  const unavailable = {status:502,data:{}};
  assert.equal(await matrixSmokeJoin(async () => unavailable, async () => assert.fail('No join after unavailable membership')), unavailable);
  let joins=0;
  await assert.rejects(matrixSmokeJoin(async () => ({status:403,data:{}}), async () => {joins++;throw new Error('Unknown join outcome');}), /Unknown join outcome/);
  assert.equal(joins,1);
});

test('a rate-limited leave rechecks membership and stops after confirmed departure', async () => {
  const departed = {status:200,data:{membership:'leave'}};
  let reads = 0, leaves = 0;
  assert.equal(await matrixSmokeLeave(async () => ++reads === 1 ? {status:200,data:{membership:'join'}} : departed,
    async () => {leaves++;return limited(5);}, async () => {}), departed);
  assert.equal(reads,2); assert.equal(leaves,1);
});

test('a forbidden membership read does not silently count as a successful leave', async () => {
  let reads = 0, leaves = 0; const success = {status:200,data:{}};
  assert.equal(await matrixSmokeLeave(async () => {reads++;return {status:403,data:{}};},
    async () => ++leaves === 1 ? limited(5) : success, async () => {}), success);
  assert.equal(reads,2); assert.equal(leaves,2);
});

test('unavailable membership and ambiguous leave errors never replay departure', async () => {
  const unavailable = {status:502,data:{}};
  assert.equal(await matrixSmokeLeave(async () => unavailable, async () => assert.fail('No leave after unavailable membership')), unavailable);
  let leaves = 0;
  await assert.rejects(matrixSmokeLeave(async () => ({status:200,data:{membership:'join'}}),
    async () => {leaves++;throw new Error('Unknown leave outcome');}), /Unknown leave outcome/);
  assert.equal(leaves,1);
});
