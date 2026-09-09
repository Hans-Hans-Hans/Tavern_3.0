import test from 'node:test';
import assert from 'node:assert/strict';
import { historyRecoverySmoke, assertHistoryRecoveryFixture } from '../scripts/smoke-history-recovery.mjs';

const origin = 'https://chat.example.test', user = '@cihistoryproof:chat.example.test';
const adminSession = { userId: '@ciadmin:chat.example.test', deviceId: 'ADMIN_DEVICE', admin: true };
const noop = async () => {};
function options() {
  const context = {}; const admin = { url: () => origin, context: () => context };
  return { origin, admin, adminSession, api: async () => ({ status: 200, data: adminSession }), ready: noop, createPage: noop, login: noop, encryptedResponse: noop, encryptedEvent: noop };
}
async function ci(run) {
  const before = { TAVERN_CI_SMOKE: process.env.TAVERN_CI_SMOKE, TAVERN_CI_TLS: process.env.TAVERN_CI_TLS };
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/tavern-ci-tls';
  try { await run(); } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
test('non-CI scopes, foreign administrators and missing helpers fail before requests', () => ci(async () => {
  let calls = 0; const base = options(); base.api = async () => { calls++; };
  for (const changed of [{ origin: 'https://real.example' }, { adminSession: { ...adminSession, userId: '@real:chat.example.test' } }, { adminSession: { ...adminSession, admin: false } }, { adminSession: { ...adminSession, deviceId: '' } }, { encryptedEvent: undefined }]) {
    await assert.rejects(historyRecoverySmoke({ ...base, ...changed }), /exact isolated CI/);
  }
  process.env.TAVERN_CI_SMOKE = 'false'; await assert.rejects(historyRecoverySmoke(base), /exact isolated CI/);
  process.env.TAVERN_CI_SMOKE = 'true'; process.env.TAVERN_CI_TLS = '/tmp/not-ci'; await assert.rejects(historyRecoverySmoke(base), /exact isolated CI/);
  assert.equal(calls, 0);
}));
test('a redirected or replaced administrator never creates the disposable account', () => ci(async () => {
  const base = options(), paths = [];
  base.api = async (_page, path) => { paths.push(path); return { status: 200, data: { ...adminSession, deviceId: 'REPLACED' } }; };
  await assert.rejects(historyRecoverySmoke(base), { code: 'ERR_ASSERTION' }); assert.deepEqual(paths, ['/api/auth/session']);
  paths.length = 0; base.admin.url = () => 'https://other.example/';
  await assert.rejects(historyRecoverySmoke(base), { code: 'ERR_ASSERTION' }); assert.deepEqual(paths, []);
}));
test('only a new fixed disposable CI identity is created and an ambiguous failure is never retried or leaked', () => ci(async () => {
  const base = options(), paths = []; let created;
  base.api = async (_page, path, body) => {
    paths.push(path); if (path === '/api/auth/session') return { status: 200, data: adminSession };
    created = body; throw new Error('upstream echoed secret ' + body.password);
  };
  await assert.rejects(historyRecoverySmoke(base), error => {
    assert.equal(error.message, 'History recovery acceptance failed while creating the disposable account. Sensitive browser details were withheld.');
    assert.ok(!error.message.includes(created.password)); return true;
  });
  assert.deepEqual(paths, ['/api/auth/session', '/api/admin/users']); assert.equal(created.username, 'cihistoryproof'); assert.equal(created.admin, undefined);
}));
test('a new recovery page cannot reuse the administrator context or send credentials into it', () => ci(async () => {
  const base = options(); let logins = 0, closed = 0;
  base.admin.context().close = async () => { closed++; };
  base.api = async (_page, path) => ({ status: path === '/api/auth/session' ? 200 : 201, data: path === '/api/auth/session' ? adminSession : {} });
  base.createPage = async () => ({ context: base.admin.context }); base.login = async () => { logins++; };
  await assert.rejects(historyRecoverySmoke(base), /signing in the original device/);
  assert.equal(logins, 0); assert.equal(closed, 0);
}));
test('owned contexts close before a credential-bearing browser error can reach outer CI diagnostics', () => ci(async () => {
  const base = options(); let closed = 0;
  const context = { close: async () => { closed++; } };
  base.api = async (_page, path) => ({ status: path === '/api/auth/session' ? 200 : 201, data: path === '/api/auth/session' ? adminSession : {} });
  base.createPage = async () => ({ context: () => context });
  base.login = async () => { throw new Error('fill("private account password")'); };
  await assert.rejects(historyRecoverySmoke(base), error => !error.message.includes('private account password') && /Sensitive browser details/.test(error.message));
  assert.equal(closed, 1);
}));

function fixture(v12 = false) {
  const nonce = 'a'.repeat(24), name = 'CI history recovery ' + nonce;
  const id = v12 ? '!' + 'A'.repeat(43) : '!history:chat.example.test';
  const event = (type, content, state_key = '') => ({ type, content, state_key, room_id: id, sender: user });
  return { id, name, nonce, events: [
    event('m.room.create', { 'm.federate': false, 'io.tavern.ci_history_recovery': nonce, room_version: v12 ? '12' : '11' }),
    event('m.room.name', { name }), event('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }),
    event('m.room.history_visibility', { history_visibility: 'joined' }), event('m.room.join_rules', { join_rule: 'invite' }), event('m.room.member', { membership: 'join' }, user),
  ] };
}
test('fresh legacy and native v12 room proofs require actual nonce, creator, encryption and solitary membership', () => {
  assert.doesNotThrow(() => assertHistoryRecoveryFixture(fixture())); assert.doesNotThrow(() => assertHistoryRecoveryFixture(fixture(true)));
  for (const mutate of [value => { value.id = '!room:elsewhere'; }, value => { value.events[0].sender = '@cialice:chat.example.test'; }, value => { value.events[0].content['io.tavern.ci_history_recovery'] = 'b'.repeat(24); }, value => { value.events[0].content.room_version = '11'; }, value => { value.events[0].content['m.federate'] = true; }, value => { value.events[2].content.algorithm = 'plaintext'; }, value => { value.events.push({ ...value.events.at(-1), state_key: '@cibob:chat.example.test' }); }, value => { value.events.push(value.events[0]); }]) {
    const value = fixture(true); mutate(value); assert.throws(() => assertHistoryRecoveryFixture(value));
  }
});
