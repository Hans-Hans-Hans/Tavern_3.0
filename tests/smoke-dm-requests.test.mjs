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
