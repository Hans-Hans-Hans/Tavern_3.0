import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const model = loadTs('../lib/turn-diagnostics.ts', {});
const { prepareDiagnosticTurn } = loadTs('../lib/turn-diagnostic-session.ts', { './turn-diagnostics': model });
const session = { userId: '@admin:local', deviceId: 'TURN', baseUrl: 'https://tavern.test/api/matrix', admin: true, passwordChangeRequired: false, mfaEnrollmentRequired: false };
async function fixture(task) {
  const fetch = globalThis.fetch, location = globalThis.location;
  globalThis.location = { origin: 'https://tavern.test' };
  const f = { base: session.baseUrl, checks: 0, stops: 0, expiry: Date.now() + 3600000, requests: [] };
  globalThis.fetch = async (url, init) => { f.requests.push({ url, init }); return new Response(JSON.stringify(session), { status: 200 }); };
  f.client = { getUserId: () => session.userId, getDeviceId: () => session.deviceId, getHomeserverUrl: () => f.base,
    checkTurnServers: async () => { f.checks++; await f.onCheck?.(); return true; }, getTurnServersExpiry: () => f.expiry,
    getTurnServers: () => [{ urls: ['turn:turn.test:3478'], username: 'ttl', credential: 'fixture' }], stopClient: () => { f.stops++; } };
  f.prepare = () => prepareDiagnosticTurn(session, f.client, () => true, new AbortController().signal);
  try { await task(f); } finally { globalThis.fetch = fetch; if (location === undefined) delete globalThis.location; else globalThis.location = location; }
}
test('a live client from another origin or gateway is rejected before native credential refresh', async () => fixture(async f => {
  for (const base of ['https://another.test/api/matrix', 'https://tavern.test/another', 'https://user:secret@tavern.test/api/matrix', 'https://tavern.test/api/matrix?access_token=secret']) {
    f.base = base; await assert.rejects(f.prepare(), error => error.status === 'unauthorized');
  }
  assert.equal(f.checks, 0); assert.equal(f.stops, 0);
}));
test('the matching existing client refreshes but is never stopped or reinitialized', async () => fixture(async f => {
  f.base += '/'; const servers = await f.prepare(); assert.equal(servers[0].urls[0], 'turn:turn.test:3478');
  assert.equal(f.checks, 1); assert.equal(f.stops, 0); assert.equal(f.requests[0].url, '/api/auth/session');
  assert.equal(f.requests[0].init.headers['X-Tavern-Device'], 'TURN');
}));
test('missing, malformed, expired or infinite SDK expiry cannot count as current credentials', async () => fixture(async f => {
  for (const expiry of [undefined, NaN, Infinity, -Infinity, Date.now() - 1, '9999999999999']) {
    f.expiry = expiry; await assert.rejects(f.prepare(), error => error.status === 'not-configured');
  }
  assert.equal(f.stops, 0);
}));
test('a live gateway change during credential refresh is rejected after the await', async () => fixture(async f => {
  f.onCheck = () => { f.base = 'https://changed.test/api/matrix'; };
  await assert.rejects(f.prepare(), error => error.status === 'unauthorized'); assert.equal(f.stops, 0);
}));
