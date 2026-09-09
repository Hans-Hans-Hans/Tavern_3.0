import test from 'node:test';
import assert from 'node:assert/strict';
import { roleMentionsSmoke, assertRoleFixtureAuthority } from '../scripts/smoke-role-mentions.mjs';

const origin = 'https://chat.example.test';
const aliceSession = { userId: '@cialice:chat.example.test', deviceId: 'CI_ALICE', admin: false };
const bobSession = { userId: '@cibob:chat.example.test', deviceId: 'CI_BOB', admin: false };
const noop = async () => {};
function options(api) {
  const aliceContext = {}, bobContext = {};
  return { origin, aliceSession, bobSession, alice: { url: () => origin, context: () => aliceContext }, bob: { url: () => origin, context: () => bobContext }, api, ready: noop, encryptedResponse: noop, encryptedEvent: noop };
}
async function ci(run) {
  const before = { TAVERN_CI_SMOKE: process.env.TAVERN_CI_SMOKE, TAVERN_CI_TLS: process.env.TAVERN_CI_TLS };
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/tavern-ci-tls';
  try { await run(); } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test('live role proof rejects non-CI origin, account, device, helpers and environment before requests', () => ci(async () => {
  let calls = 0; const base = options(async () => { calls++; });
  for (const changes of [
    { origin: 'https://tavern.example.com' }, { aliceSession: { ...aliceSession, userId: '@real:chat.example.test' } },
    { bobSession: { ...bobSession, admin: true } }, { bobSession: { ...bobSession, deviceId: '' } }, { encryptedEvent: undefined },
  ]) await assert.rejects(roleMentionsSmoke({ ...base, ...changes }), /exact isolated CI/);
  process.env.TAVERN_CI_SMOKE = 'false'; await assert.rejects(roleMentionsSmoke(base), /exact isolated CI/);
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/other-stack';
  await assert.rejects(roleMentionsSmoke(base), /exact isolated CI/); assert.equal(calls, 0);
}));

test('two declared accounts cannot share one owning cookie/crypto context', () => ci(async () => {
  let calls = 0; const base = options(async () => { calls++; }); base.bob.context = base.alice.context;
  await assert.rejects(roleMentionsSmoke(base), /own browser context/); assert.equal(calls, 0);
}));

test('a replaced owning session fails before preference changes or creating fixtures', () => ci(async () => {
  const calls = [], base = options(async (page, path) => {
    calls.push(path); return { status: 200, data: page === base.alice ? aliceSession : { ...bobSession, deviceId: 'REPLACED' } };
  });
  await assert.rejects(roleMentionsSmoke(base)); assert.deepEqual(calls, ['/api/auth/session', '/api/auth/session']);
}));

test('redirected owning browser is rejected before native or account requests', () => ci(async () => {
  let calls = 0; const base = options(async () => { calls++; }); base.alice.url = () => 'https://tavern.example.com/';
  await assert.rejects(roleMentionsSmoke(base), /isolated owning browser/); assert.equal(calls, 0);
}));

test('fixture authority accepts native v12 creator power without an explicit power-level user entry', () => {
  assert.doesNotThrow(() => assertRoleFixtureAuthority({ sender: aliceSession.userId, content: { room_version: '12' } }, { users: {}, users_default: 0, state_default: 50 }));
  assert.doesNotThrow(() => assertRoleFixtureAuthority({ sender: aliceSession.userId, content: { room_version: '11' } }, { users: { [aliceSession.userId]: 100 }, users_default: 0, state_default: 50 }));
  assert.doesNotThrow(() => assertRoleFixtureAuthority({ sender: aliceSession.userId, content: {} }, { users: { [aliceSession.userId]: 100 }, users_default: 0 }));
});

test('fixture authority rejects additional creators, a foreign creation sender and elevated recipients', () => {
  const create = { sender: aliceSession.userId, content: { room_version: '12' } }, powers = { users: {}, users_default: 0 };
  assert.throws(() => assertRoleFixtureAuthority({ ...create, content: { ...create.content, additional_creators: [bobSession.userId] } }, powers));
  assert.throws(() => assertRoleFixtureAuthority({ ...create, sender: bobSession.userId }, powers));
  assert.throws(() => assertRoleFixtureAuthority(create, { ...powers, users: { [bobSession.userId]: 100 } }));
  assert.throws(() => assertRoleFixtureAuthority({ ...create, content: { room_version: '11' } }, powers));
});

test('actual live probe accepts a freshly returned native v12 hash room and validates its original creation state', () => ci(async () => {
  const id = '!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ', stop = new Error('Reached the second guarded creation');
  const calls = []; let creation, inspected = 0;
  const base = options(async (page, path, body) => {
    calls.push(path);
    if (path === '/api/auth/session') return { status: 200, data: page === base.alice ? aliceSession : bobSession };
    if (path === '/api/social/invitation-privacy') return { status: 200, data: { invitations: 'everyone' } };
    if (path === '/_matrix/client/v3/createRoom') { if (creation) throw stop; creation = body; return { status: 200, data: { room_id: id } }; }
    assert.equal(path, '/_matrix/client/v3/rooms/' + encodeURIComponent(id) + '/state'); inspected++;
    return { status: 200, data: [
      { type: 'm.room.create', state_key: '', sender: aliceSession.userId, content: { ...creation.creation_content, room_version: '12' } },
      { type: 'm.room.name', state_key: '', content: { name: creation.name } },
      { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
      { type: 'm.room.member', state_key: aliceSession.userId, content: { membership: 'join' } },
      { type: 'm.room.power_levels', state_key: '', content: { users: {}, users_default: 0, state_default: 50 } },
    ] };
  });
  await assert.rejects(roleMentionsSmoke(base), error => error === stop); assert.equal(inspected, 1); assert.equal(calls.filter(path => path.endsWith('/createRoom')).length, 2);
}));

test('actual live probe rejects foreign legacy IDs and malformed v12 hashes before inspecting their rooms', () => ci(async () => {
  for (const id of ['!room:foreign.example', '!' + 'A'.repeat(42), '!' + 'A'.repeat(44), '!' + 'A'.repeat(42) + '/', '!room:chat.example.test/path']) {
    let inspected = false;
    const base = options(async (page, path) => {
      if (path === '/api/auth/session') return { status: 200, data: page === base.alice ? aliceSession : bobSession };
      if (path === '/api/social/invitation-privacy') return { status: 200, data: { invitations: 'everyone' } };
      if (path === '/_matrix/client/v3/createRoom') return { status: 200, data: { room_id: id } };
      inspected = true; throw new Error('A foreign or malformed ID must not be followed.');
    });
    await assert.rejects(roleMentionsSmoke(base), { code: 'ERR_ASSERTION' }); assert.equal(inspected, false);
  }
}));

test('a returned hash cannot bypass inspected version, creator or unique run-marker checks', () => ci(async () => {
  for (const patch of [{ room_version: '11' }, { sender: bobSession.userId }, { 'io.tavern.ci_role_mentions': 'another-run' }, { 'm.federate': true }]) {
    const id = '!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ'; let creation, inspections = 0, creates = 0;
    const base = options(async (page, path, body) => {
      if (path === '/api/auth/session') return { status: 200, data: page === base.alice ? aliceSession : bobSession };
      if (path === '/api/social/invitation-privacy') return { status: 200, data: { invitations: 'everyone' } };
      if (path === '/_matrix/client/v3/createRoom') { creates++; creation = body; return { status: 200, data: { room_id: id } }; }
      assert.equal(path, '/_matrix/client/v3/rooms/' + encodeURIComponent(id) + '/state'); inspections++;
      return { status: 200, data: [{ type: 'm.room.create', state_key: '', sender: patch.sender || aliceSession.userId, content: { ...creation.creation_content, room_version: '12', ...patch } }] };
    });
    await assert.rejects(roleMentionsSmoke(base), { code: 'ERR_ASSERTION' }); assert.equal(creates, 1); assert.equal(inspections, 1);
  }
}));
