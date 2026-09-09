import test from 'node:test';
import assert from 'node:assert/strict';
import { dmRequestsSmoke } from '../scripts/smoke-dm-requests.mjs';

const origin = 'https://chat.example.test';
const aliceSession = { userId: '@cialice:chat.example.test', deviceId: 'CI_ALICE', admin: false };
const bobSession = { userId: '@cibob:chat.example.test', deviceId: 'CI_BOB', admin: false };
const noop = async () => {};
function options(api) {
  return { origin, aliceSession, bobSession, alice: { url: () => origin + '/' }, bob: { url: () => origin + '/' }, api, ready: noop, encryptedResponse: noop, encryptedEvent: noop };
}
async function ci(run) {
  const previous = { smoke: process.env.TAVERN_CI_SMOKE, tls: process.env.TAVERN_CI_TLS };
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/tavern-ci-tls';
  try { await run(); } finally {
    for (const [key, value] of [['TAVERN_CI_SMOKE', previous.smoke], ['TAVERN_CI_TLS', previous.tls]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('live DM probe rejects non-CI origin, identities, device scope and environment before any request', () => ci(async () => {
  let calls = 0; const base = options(async () => { calls++; });
  for (const changes of [
    { origin: 'https://tavern.example.com' },
    { bobSession: { ...bobSession, userId: '@real:chat.example.test' } },
    { aliceSession: { ...aliceSession, admin: true } },
    { aliceSession: { ...aliceSession, deviceId: '' } },
  ]) await assert.rejects(dmRequestsSmoke({ ...base, ...changes }), /exact isolated CI/);
  process.env.TAVERN_CI_SMOKE = 'false';
  await assert.rejects(dmRequestsSmoke(base), /exact isolated CI/);
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/other-stack';
  await assert.rejects(dmRequestsSmoke(base), /exact isolated CI/);
  assert.equal(calls, 0);
}));

test('declared CI identity cannot authorize a replaced owning browser session', () => ci(async () => {
  const calls = [], opts = options(async (_page, path) => {
    calls.push(path); return { status: 200, data: { ...aliceSession, deviceId: 'REPLACEMENT' } };
  });
  await assert.rejects(dmRequestsSmoke(opts));
  assert.deepEqual(calls, ['/api/auth/session']);
}));

test('a redirected browser is rejected before account inspection or fixture writes', () => ci(async () => {
  let calls = 0; const opts = options(async () => { calls++; });
  opts.alice = { url: () => 'https://tavern.example.com/' };
  await assert.rejects(dmRequestsSmoke(opts), /isolated owning browser/);
  assert.equal(calls, 0);
}));

test('the actual DM probe proves freshly created legacy and v12 rooms before issuing a native invitation', () => ci(async () => {
  for (const id of ['!dm:chat.example.test', '!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ']) for (const valid of [true, false]) {
    let configuration, invitations = 0; const stop = new Error('verified native invitation boundary');
    const opts = options(async (page, path, body) => {
      if (path === '/api/auth/session') return { status: 200, data: page === opts.alice ? aliceSession : bobSession };
      if (path === '/api/social/invitation-privacy') return { status: 200, data: { invitations: 'everyone' } };
      if (path.endsWith('/account_data/m.direct')) return { status: 200, data: {} };
      if (path.endsWith('/createRoom')) { configuration = body; return { status: 200, data: { room_id: id } }; }
      if (path.endsWith('/state')) return { status: 200, data: [
        { type: 'm.room.create', state_key: '', sender: aliceSession.userId, content: { ...configuration.creation_content,
          room_version: id.includes(':') ? '11' : '12', ...(valid ? {} : { 'm.federate': true }) } },
        { type: 'm.room.name', state_key: '', content: { name: configuration.name } },
        { type: 'm.room.member', state_key: aliceSession.userId, content: { membership: 'join' } },
        { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } }, ...configuration.initial_state,
      ] };
      assert.ok(decodeURIComponent(path).endsWith('/state/m.room.member/' + bobSession.userId));
      if (body === undefined) return { status: 404, data: { errcode: 'M_NOT_FOUND' } };
      invitations++; throw stop;
    });
    await assert.rejects(dmRequestsSmoke(opts), error => valid ? error === stop : error.code === 'ERR_ASSERTION');
    assert.equal(invitations, valid ? 1 : 0);
  }
}));
