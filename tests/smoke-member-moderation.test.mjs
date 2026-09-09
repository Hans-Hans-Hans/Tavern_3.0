// Guard and fixture-lifecycle tests only. Native moderation acceptance runs in
// the real native stack; this fixture does not emulate Synapse auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memberModerationSmoke } from '../scripts/smoke-member-moderation.mjs';

const origin = 'https://chat.example.test';
const adminSession = { userId: '@ciadmin:chat.example.test', deviceId: 'CI_ADMIN', admin: true };
const aliceSession = { userId: '@cialice:chat.example.test', deviceId: 'CI_ALICE', admin: false };
const bobSession = { userId: '@cibob:chat.example.test', deviceId: 'CI_BOB', admin: false };
const nativeId = '!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ';
function options(api) {
  const page = () => { const context = {}; return { url: () => origin, context: () => context }; };
  return { admin: page(), alice: page(), bob: page(), adminSession, aliceSession, bobSession, origin, api };
}
async function ci(run) {
  const before = { TAVERN_CI_SMOKE: process.env.TAVERN_CI_SMOKE, TAVERN_CI_TLS: process.env.TAVERN_CI_TLS };
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/tavern-ci-tls';
  try { await run(); } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('member moderation acceptance rejects non-CI origin, accounts, devices, helpers and environment before requests', () => ci(async () => {
  let requests = 0; const base = options(async () => { requests++; });
  for (const change of [
    { origin: 'https://production.example' }, { adminSession: { ...adminSession, admin: false } },
    { aliceSession: { ...aliceSession, userId: '@real:chat.example.test' } }, { bobSession: { ...bobSession, admin: true } },
    { bobSession: { ...bobSession, deviceId: '' } }, { api: undefined },
  ]) await assert.rejects(memberModerationSmoke({ ...base, ...change }), /exact isolated CI/);
  process.env.TAVERN_CI_SMOKE = 'false'; await assert.rejects(memberModerationSmoke(base), /exact isolated CI/);
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/another-stack';
  await assert.rejects(memberModerationSmoke(base), /exact isolated CI/); assert.equal(requests, 0);
}));

test('three declared accounts require distinct browser ownership and expected origins', () => ci(async () => {
  let requests = 0; const base = options(async () => { requests++; });
  base.bob.context = base.alice.context;
  await assert.rejects(memberModerationSmoke(base), /separate owning contexts/); assert.equal(requests, 0);
  const redirected = options(async () => { requests++; }); redirected.admin.url = () => 'https://production.example/';
  await assert.rejects(memberModerationSmoke(redirected), /isolated owning origin/); assert.equal(requests, 0);
}));

test('replaced owning session fails before preferences or native fixture mutations', () => ci(async () => {
  const calls = [], base = options(async (page, path) => {
    calls.push(path);
    return { status: 200, data: page === base.admin ? adminSession : page === base.alice ? aliceSession : { ...bobSession, deviceId: 'REPLACED' } };
  });
  await assert.rejects(memberModerationSmoke(base), /owning account\/session changed/);
  assert.deepEqual(calls, ['/api/auth/session', '/api/auth/session', '/api/auth/session']);
}));

function setup({ id = nativeId, patchCreation, failSecond = new Error('stop after the first creation proof'), changeOwnerAfterProof = false } = {}) {
  let configuration, creates = 0, proved = false, member = 'join';
  const calls = [], base = options(async (page, path, body, _native, _optional, method) => {
    calls.push({ page, path, body, method });
    if (path === '/api/auth/session') return { status: 200, data: page === base.admin
      ? changeOwnerAfterProof && proved ? { ...adminSession, deviceId: 'REPLACED' } : adminSession
      : page === base.alice ? aliceSession : bobSession };
    if (path === '/api/social/invitation-privacy') return { status: 200, data: { invitations: 'everyone' } };
    if (path === '/_matrix/client/v3/createRoom') {
      creates++; if (creates > 1) throw failSecond;
      configuration = structuredClone(body); return { status: 200, data: { room_id: id } };
    }
    const room = '/_matrix/client/v3/rooms/' + encodeURIComponent(id);
    if (path === room + '/state') {
      const create = { type: 'm.room.create', state_key: '', sender: adminSession.userId,
        content: { ...configuration.creation_content, room_version: '12' } };
      if (patchCreation) patchCreation(create);
      const events = [create,
        { type: 'm.room.name', state_key: '', content: { name: configuration.name } },
        { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
        { type: 'm.room.power_levels', state_key: '', content: { users: {}, users_default: 0, state_default: 50 } },
        { type: 'm.room.member', state_key: adminSession.userId, content: { membership: member } },
      ];
      proved = true; return { status: 200, data: events };
    }
    if (path.startsWith(room + '/state/m.room.member/')) {
      const user = decodeURIComponent(path.slice((room + '/state/m.room.member/').length));
      return user === adminSession.userId ? { status: 200, data: { membership: member } } : { status: 404, data: { errcode: 'M_NOT_FOUND' } };
    }
    if (path === room + '/leave') { member = 'leave'; return { status: 200, data: {} }; }
    throw new Error('Unexpected guard fixture request: ' + path);
  });
  return { base, calls, failSecond, configuration: () => configuration };
}

test('actual probe accepts proven native v12 creation and cleans only its owning membership on early failure', () => ci(async () => {
  const fixture = setup();
  await assert.rejects(memberModerationSmoke(fixture.base), error => error === fixture.failSecond);
  const creates = fixture.calls.filter(call => call.path.endsWith('/createRoom'));
  assert.equal(creates.length, 2);
  assert.equal(Object.hasOwn(fixture.configuration(), 'invite'), false, 'Creation must not replay invitation side effects');
  assert.equal(Object.hasOwn(fixture.configuration(), 'room_version'), false, 'Use the actual configured native version and prove its creation');
  const leaves = fixture.calls.filter(call => call.path.endsWith('/leave'));
  assert.equal(leaves.length, 1); assert.equal(leaves[0].page, fixture.base.admin);
  assert.equal(fixture.calls.some(call => call.body !== undefined && call.path.includes('/state/')), false, 'No dependent state write occurs before all creation proofs');
}));

test('foreign or malformed returned IDs are never inspected or cleaned up', () => ci(async () => {
  for (const id of ['!room:production.example', '!' + 'A'.repeat(42), '!' + 'A'.repeat(44), '!' + 'A'.repeat(42) + '/', '!room:chat.example.test/path']) {
    const fixture = setup({ id }); await assert.rejects(memberModerationSmoke(fixture.base));
    assert.equal(fixture.calls.some(call => call.path.includes('/rooms/')), false);
  }
}));

test('unproved creation ownership, version, immutable marker or locality forbids dependent writes and cleanup', () => ci(async () => {
  for (const patchCreation of [
    create => { create.sender = aliceSession.userId; }, create => { create.content.room_version = '11'; },
    create => { create.content['m.federate'] = true; }, create => { create.content['io.tavern.ci_audio'] = 'another-run'; },
    create => { create.content.additional_creators = [aliceSession.userId]; },
  ]) {
    const fixture = setup({ patchCreation }); await assert.rejects(memberModerationSmoke(fixture.base));
    assert.equal(fixture.calls.filter(call => call.path.endsWith('/createRoom')).length, 1);
    assert.equal(fixture.calls.filter(call => call.body !== undefined && !call.path.endsWith('/createRoom')).length, 0);
  }
}));

test('a cookie-owner replacement after creation cannot retarget later setup or fixture cleanup', () => ci(async () => {
  const fixture = setup({ changeOwnerAfterProof: true });
  await assert.rejects(memberModerationSmoke(fixture.base), AggregateError);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/createRoom')).length, 1);
  assert.equal(fixture.calls.filter(call => call.body !== undefined && !call.path.endsWith('/createRoom')).length, 0);
}));
