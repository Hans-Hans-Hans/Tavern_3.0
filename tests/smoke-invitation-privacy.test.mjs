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
