import test from 'node:test';
import assert from 'node:assert/strict';
import { invitationPrivacySmoke } from '../scripts/smoke-invitation-privacy.mjs';

const origin = 'https://chat.example.test';
const adminSession = { userId: '@ciadmin:chat.example.test', deviceId: 'CI_ADMIN', admin: true };
const bobSession = { userId: '@cibob:chat.example.test', deviceId: 'CI_BOB', admin: false };
const noop = async () => {};
const options = api => ({ origin, adminSession, bobSession, admin: { url: () => origin }, bob: { url: () => origin }, api, createPage: noop, login: noop });
async function ci(run) {
  const before = { TAVERN_CI_SMOKE: process.env.TAVERN_CI_SMOKE, TAVERN_CI_TLS: process.env.TAVERN_CI_TLS };
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/tavern-ci-tls';
  try { await run(); } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
test('native invitation privacy probe refuses non-CI scope before requests or account creation', () => ci(async () => {
  let calls = 0; const base = options(async () => { calls++; });
  for (const changes of [
    { origin: 'https://tavern.example.com' }, { adminSession: { ...adminSession, admin: false } },
    { bobSession: { ...bobSession, userId: '@real:chat.example.test' } }, { bobSession: { ...bobSession, deviceId: '' } },
  ]) await assert.rejects(invitationPrivacySmoke({ ...base, ...changes }), /exact isolated CI/);
  process.env.TAVERN_CI_SMOKE = 'false'; await assert.rejects(invitationPrivacySmoke(base), /exact isolated CI/);
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/another-stack';
  await assert.rejects(invitationPrivacySmoke(base), /exact isolated CI/); assert.equal(calls, 0);
}));
test('a replaced recipient session cannot authorize preference changes or fixture creation', () => ci(async () => {
  const calls = [], base = options(async (page, path) => {
    calls.push(path); return { status: 200, data: page === base.admin ? adminSession : { ...bobSession, deviceId: 'REPLACED' } };
  });
  await assert.rejects(invitationPrivacySmoke(base)); assert.deepEqual(calls, ['/api/auth/session', '/api/auth/session']);
}));
test('a redirected owning browser is rejected without contacting the redirected origin', () => ci(async () => {
  let calls = 0; const base = options(async () => { calls++; }); base.admin = { url: () => 'https://tavern.example.com/' };
  await assert.rejects(invitationPrivacySmoke(base), /isolated owning browser/); assert.equal(calls, 0);
}));

test('the native privacy probe inspects immutable legacy/v12 creation before proceeding to another room', () => ci(async () => {
  for (const id of ['!privacy:chat.example.test', '!Nhcu5BS-UMnFX7hBVfVSoXiD7OgH6iRT-xyIuqDnpYQ']) for (const valid of [true, false]) {
    const sender = { url: () => origin }, senderSession = { userId: '@ciinviter:chat.example.test', deviceId: 'SENDER', admin: false };
    let configuration, creates = 0; const stop = new Error('next verified fixture boundary');
    const base = options(async (page, path, body) => {
      if (path === '/api/auth/session') return { status: 200, data: page === base.admin ? adminSession : page === sender ? senderSession : bobSession };
      if (path.includes('/account_data/')) return { status: 200, data: {} };
      if (path === '/api/social') return { status: 200, data: { privacy: 'everyone', requests: [], blocked: [] } };
      if (path === '/api/admin/users') return { status: 201, data: {} };
      if (path.endsWith('/createRoom')) { if (++creates === 2) throw stop; configuration = body; return { status: 200, data: { room_id: id } }; }
      assert.ok(path.endsWith('/state'));
      return { status: 200, data: [
        { type: 'm.room.create', state_key: '', sender: senderSession.userId, content: { ...configuration.creation_content,
          room_version: id.includes(':') ? '11' : '12', ...(valid ? {} : { 'io.tavern.ci_invitation_privacy': 'wrong-run' }) } },
        { type: 'm.room.name', state_key: '', content: { name: configuration.name } },
        { type: 'm.room.member', state_key: senderSession.userId, content: { membership: 'join' } },
        { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } }, ...configuration.initial_state,
      ] };
    }); base.createPage = async () => sender;
    await assert.rejects(invitationPrivacySmoke(base), error => valid ? error === stop : error.code === 'ERR_ASSERTION');
    assert.equal(creates, valid ? 2 : 1);
  }
}));
