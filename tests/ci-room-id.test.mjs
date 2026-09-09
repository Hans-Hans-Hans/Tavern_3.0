import test from 'node:test';
import assert from 'node:assert/strict';
import { isCiRoomId, assertCiRoomCreation } from '../scripts/ci-room-id.mjs';
import { afkSmoke } from '../scripts/smoke-afk.mjs';
import { eligibilitySmoke } from '../scripts/smoke-eligibility.mjs';
import { profilePolicySmoke } from '../scripts/smoke-profile-policy.mjs';

const hash = '!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ';
const origin = 'https://chat.example.test', runId = 'a'.repeat(24);
const adminSession = { userId: '@ciadmin:chat.example.test', admin: true, deviceId: 'ADMIN' };
const aliceSession = { userId: '@cialice:chat.example.test', admin: false, deviceId: 'ALICE' };
const event = (type, content, state_key = '') => ({ type, content, state_key });
function proof(id = hash, space = false) {
  return { id, creator: adminSession.userId, name: space ? 'CI AFK settings server' : 'CI AFK voice destination',
    marker: 'io.tavern.ci_afk', runId, space, events: [
      { ...event('m.room.create', { room_version: id.includes(':') ? '11' : '12', 'm.federate': false,
        'io.tavern.ci_afk': runId, ...(space ? { type: 'm.space' } : {}) }), sender: adminSession.userId },
      event('m.room.name', { name: space ? 'CI AFK settings server' : 'CI AFK voice destination' }),
      event('m.room.member', { membership: 'join' }, adminSession.userId),
      event('m.room.member', { membership: 'join' }, aliceSession.userId),
    ] };
}
async function ci(run) {
  const old = { TAVERN_CI_SMOKE: process.env.TAVERN_CI_SMOKE, TAVERN_CI_TLS: process.env.TAVERN_CI_TLS };
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/tavern-ci-tls';
  try { await run(); } finally { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const options = api => ({ origin, adminSession, aliceSession, admin: { url: () => origin }, alice: { url: () => origin }, api });

test('CI room syntax accepts exact isolated legacy or canonical v12 hashes, never treats a hash as locality', () => {
  for (const id of [hash, '!' + 'A'.repeat(43), '!legacy:chat.example.test']) assert.equal(isCiRoomId(id), true);
  for (const id of [null, false, '', '!legacy:real.example', '!legacy:chat.example.test:443', '!x:chat.example.test/path',
    '!x\x00:chat.example.test', '!x\x7f:chat.example.test', '!' + 'A'.repeat(42), '!' + 'A'.repeat(44),
    '!' + 'A'.repeat(42) + 'B', hash + '=', hash + '?x', hash + '#x', hash + '/x']) assert.equal(isCiRoomId(id), false, String(id));
});

test('native fixture proof accepts both legacy and v12 only with exact immutable creator, marker, version and membership', () => {
  for (const id of [hash, '!legacy:chat.example.test']) assert.doesNotThrow(() => assertCiRoomCreation(proof(id)));
  for (const mutate of [
    p => { p.events[0].sender = '@real:chat.example.test'; },
    p => { p.events[0].content['m.federate'] = true; },
    p => { delete p.events[0].content['io.tavern.ci_afk']; },
    p => { p.events[0].content['io.tavern.ci_afk'] = 'b'.repeat(24); },
    p => { p.events[0].content.room_version = '11'; },
    p => { p.events[0].content.additional_creators = ['@real:chat.example.test']; },
    p => { p.events[0].room_id = '!another:chat.example.test'; },
    p => { p.events[2].content.membership = 'leave'; },
    p => { p.events[1].content.name = 'Another room'; },
    p => { p.events.push(p.events[0]); },
  ]) { const p = proof(); mutate(p); assert.throws(() => assertCiRoomCreation(p)); }
  const legacy = proof('!legacy:chat.example.test'); legacy.events[0].content.room_version = '12';
  assert.throws(() => assertCiRoomCreation(legacy));
});

test('actual AFK probe requires isolated sessions before creation and proves native marker before its next fixture', () => ci(async () => {
  for (const valid of [true, false]) {
    let creations = 0, config;
    const stop = new Error('next fixture boundary');
    const opts = options(async (page, path, body) => {
      if (path === '/api/auth/session') return { status: 200, data: page === opts.admin ? adminSession : aliceSession };
      if (path.endsWith('/createRoom')) { if (++creations === 2) throw stop; config = body; return { status: 200, data: { room_id: '!afk:chat.example.test' } }; }
      assert.equal(path, '/_matrix/client/v3/rooms/!afk%3Achat.example.test/state');
      const p = proof('!afk:chat.example.test', true); p.events[0].content = { ...config.creation_content, room_version: '11' };
      if (!valid) delete p.events[0].content['io.tavern.ci_afk'];
      return { status: 200, data: p.events };
    });
    await assert.rejects(afkSmoke(opts), error => valid ? error === stop : error.code === 'ERR_ASSERTION');
    assert.equal(creations, valid ? 2 : 1);
    assert.match(config.creation_content['io.tavern.ci_afk'], /^[a-f0-9]{24}$/);
    assert.equal(config.room_version, '11', 'The server power-ceiling probe keeps its explicit legacy version.');
  }
}));

for (const smoke of [eligibilitySmoke, profilePolicySmoke]) {
  test(smoke.name + ' refuses unmarked, foreign or redirected AFK fixtures before requests', () => ci(async () => {
    let calls = 0; const base = options(async () => { calls++; }); base.fixture = { server: '!s:chat.example.test', voice: hash, runId };
    for (const changes of [
      { fixture: { ...base.fixture, runId: '' } }, { fixture: { ...base.fixture, voice: '!v:real.example' } },
      { origin: 'https://real.example' }, { alice: { url: () => 'https://real.example' } },
      { adminSession: { ...adminSession, userId: '@real:chat.example.test' } },
    ]) await assert.rejects(smoke({ ...base, ...changes }), /isolated CI/);
    assert.equal(calls, 0);
  }));

  test(smoke.name + ' reads both legacy and v12 native creation proofs and refuses a wrong marker before writes', () => ci(async () => {
    for (const id of ['!v:chat.example.test', hash]) {
      let writes = 0, channelRead = false;
      const fixture = { server: '!s:chat.example.test', voice: id, runId };
      const opts = options(async (page, path, body) => {
        if (body !== undefined) { writes++; throw new Error('Unexpected fixture mutation'); }
        if (path === '/api/auth/session') return { status: 200, data: page === opts.admin ? adminSession : aliceSession };
        const selected = decodeURIComponent(path).includes('/rooms/' + fixture.server + '/') ? fixture.server : id;
        const space = selected === fixture.server, p = proof(selected, space);
        if (space) p.events.push(event('m.space.child', { via: ['chat.example.test'] }, id),
          event('io.tavern.roles', { owner: adminSession.userId, roles: [], members: {} }),
          event('m.room.power_levels', { users: { [adminSession.userId]: 100, [aliceSession.userId]: 100 } }),
          event('io.tavern.server.eligibility', { requireVerifiedEmail: false, minimumAccountAgeSeconds: 0 }), event('m.room.join_rules', { join_rule: 'invite' }));
        else { channelRead = true; p.events[0].content['io.tavern.ci_afk'] = 'b'.repeat(24); }
        return { status: 200, data: p.events };
      }); opts.fixture = fixture;
      await assert.rejects(smoke(opts), error => error.code === 'ERR_ASSERTION');
      assert.equal(channelRead, true, 'A correct legacy server reaches the separately verified channel.'); assert.equal(writes, 0);
    }
  }));
}
