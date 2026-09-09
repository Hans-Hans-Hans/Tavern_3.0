// Real managed logins, production recovery UI and native encrypted key backup.
// No SDK, crypto, network routes or account responses are mocked by this probe.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { encodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { isCiRoomId } from './ci-room-id.mjs';
import { matrixSmokeRequest, matrixSmokeCreateFixture } from './matrix-smoke-request.mjs';

const ORIGIN = 'https://chat.example.test', ADMIN = '@ciadmin:chat.example.test';
const USERNAME = 'cihistoryproof', USER = '@' + USERNAME + ':chat.example.test';
const MARKER = 'io.tavern.ci_history_recovery';

export function assertHistoryRecoveryFixture({ id, events, name, nonce }) {
  assert.ok(isCiRoomId(id)); assert.ok(Array.isArray(events) && events.length <= 100);
  assert.ok(typeof name === 'string' && name.startsWith('CI history recovery ')); assert.match(nonce, /^[a-f0-9]{24}$/);
  const seen = new Set();
  for (const event of events) {
    assert.ok(event && typeof event.type === 'string' && typeof event.state_key === 'string' && event.content && typeof event.content === 'object' && !Array.isArray(event.content));
    const key = JSON.stringify([event.type, event.state_key]); assert.ok(!seen.has(key)); seen.add(key);
    if (event.room_id !== undefined) assert.equal(event.room_id, id);
  }
  const find = (type, key = '') => events.find(event => event.type === type && event.state_key === key);
  const create = find('m.room.create');
  assert.equal(create?.sender, USER); assert.equal(create.content[MARKER], nonce); assert.equal(create.content['m.federate'], false);
  assert.equal(create.content.type, undefined); assert.equal(create.content.additional_creators, undefined);
  assert.equal(!id.includes(':'), create.content.room_version === '12');
  assert.equal(find('m.room.name')?.content.name, name);
  assert.equal(find('m.room.encryption')?.content.algorithm, 'm.megolm.v1.aes-sha2');
  assert.equal(find('m.room.history_visibility')?.content.history_visibility, 'joined');
  assert.equal(find('m.room.join_rules')?.content.join_rule, 'invite');
  assert.deepEqual(events.filter(event => event.type === 'm.room.member').map(event => [event.state_key, event.content.membership]), [[USER, 'join']]);
  assert.ok(!events.some(event => event.type === 'm.space.parent'));
}

export async function historyRecoverySmoke({ admin, adminSession, origin, api, ready, createPage, login, encryptedResponse, encryptedEvent }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls' || origin !== ORIGIN
    || adminSession?.userId !== ADMIN || adminSession.admin !== true || typeof adminSession.deviceId !== 'string' || !adminSession.deviceId
    || ![api, ready, createPage, login, encryptedResponse, encryptedEvent].every(value => typeof value === 'function')) {
    throw new Error('History recovery acceptance requires the exact isolated CI stack and administrator.');
  }
  assert.equal(new URL(admin.url()).origin, ORIGIN, 'Use only the isolated administrator browser.');
  const checked = (response, status = 200) => { assert.equal(response.status, status, 'The isolated operation returned an unexpected HTTP status.'); return response.data; };
  const adminNow = checked(await matrixSmokeRequest(() => api(admin, '/api/auth/session')));
  assert.equal(adminNow.userId, ADMIN); assert.equal(adminNow.admin, true); assert.equal(adminNow.deviceId, adminSession.deviceId);
  let credential = 'Ci!' + randomBytes(24).toString('base64url'), recoveryKey = '', stage = 'creating the disposable account';
  const owned = [], contexts = new Set([admin.context()]);
  const nonce = randomBytes(12).toString('hex'), name = 'CI history recovery ' + nonce;
  let roomId;
  const native = (page, path, body, method) => {
    assert.equal(new URL(page.url()).origin, ORIGIN);
    const request = () => api(page, '/_matrix/client/v3' + path, body, true, false, method);
    return body === undefined || method === 'PUT' || path === '/keys/query' ? matrixSmokeRequest(request) : request();
  };
  const room = () => { assert.ok(isCiRoomId(roomId)); return '/rooms/' + encodeURIComponent(roomId); };
  const session = async (page, expected) => {
    assert.equal(new URL(page.url()).origin, ORIGIN);
    const value = checked(await matrixSmokeRequest(() => api(page, '/api/auth/session')));
    assert.equal(value.userId, USER); assert.equal(value.admin, false); assert.ok(typeof value.deviceId === 'string' && value.deviceId.length > 0 && value.deviceId.length <= 255);
    if (expected) assert.equal(value.deviceId, expected.deviceId);
    return value;
  };
  async function freshPage() {
    const value = await createPage();
    assert.ok(value !== admin && !contexts.has(value.context()), 'A recovery device must own a fresh isolated browser context.');
    contexts.add(value.context()); owned.push(value); return value;
  }
  async function openSecurity(page) {
    await page.goto(ORIGIN + (roomId ? '/#room=' + encodeURIComponent(roomId) : '/')); await ready(page);
    await session(page);
    await page.getByRole('button', { name: 'Tavern settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Privacy', exact: true }).click();
    const panel = page.locator('section.session-manager').filter({ has: page.getByRole('heading', { name: 'Encryption identity & recovery', exact: true }) });
    await expect(panel).toBeVisible(); return panel;
  }
  async function closeSecurity(page) { await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click(); }
  async function backup(page) {
    const value = checked(await native(page, '/room_keys/version'));
    assert.ok(typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 255);
    assert.equal(value.algorithm, 'm.megolm_backup.v1.curve25519-aes-sha2'); assert.ok(typeof value.auth_data?.public_key === 'string');
    return { version: value.version, publicKey: value.auth_data.public_key };
  }
  async function signing(page) {
    const value = checked(await native(page, '/keys/query', { device_keys: { [USER]: [] } }));
    const identity = value.master_keys?.[USER]; assert.equal(identity?.user_id, USER);
    assert.ok(identity.keys && Object.keys(identity.keys).length === 1);
    return identity.keys;
  }
  async function shown(page, eventId, text) {
    await page.goto(ORIGIN + '/#room=' + encodeURIComponent(roomId)); await ready(page); await session(page);
    await expect(page.locator('article.message[id=' + JSON.stringify('message-' + eventId) + '] .message-body')).toHaveText(text, { timeout: 60000 });
  }
  async function stores(page) {
    return page.evaluate(async () => (await indexedDB.databases()).map(item => item.name).filter(name => name?.startsWith('harbor-crypto-@cihistoryproof:chat.example.test-') && name.endsWith('::matrix-sdk-crypto')));
  }
  try {
    // Never overwrite an existing account or replay an ambiguous creation.
    checked(await api(admin, '/api/admin/users', { username: USERNAME, displayName: 'CI history recovery', password: credential }), 201);
    stage = 'signing in the original device';
    const original = await freshPage(); await login(original, USERNAME, credential);
    const firstSession = await session(original);
    stage = 'configuring the original encrypted recovery key';
    let panel = await openSecurity(original);
    await expect(panel.getByRole('button', { name: 'Set up a recovery key', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Set up a recovery key', exact: true }).click();
    recoveryKey = await panel.getByRole('textbox', { name: 'Recovery key', exact: true }).inputValue();
    assert.ok(recoveryKey.length >= 40 && recoveryKey.length <= 100 && /^[1-9A-HJ-NP-Za-km-z ]+$/.test(recoveryKey), 'The SDK must generate a bounded recovery key.');
    await panel.getByLabel('I saved this key in a safe place.', { exact: true }).check();
    await panel.getByLabel('Account password', { exact: true }).fill(credential);
    await panel.getByRole('button', { name: 'Enable identity & backup', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('Identity created and encrypted key backup enabled.', { timeout: 90000 });
    const originalBackup = await backup(original), originalSigning = await signing(original);
    await closeSecurity(original);
    stage = 'creating the encrypted private history fixture';
    const created = checked(await matrixSmokeCreateFixture(body => native(original, '/createRoom', body), {
      name, visibility: 'private', preset: 'private_chat', creation_content: { 'm.federate': false, [MARKER]: nonce },
      initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }, { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } }],
    }));
    roomId = created.room_id;
    assertHistoryRecoveryFixture({ id: roomId, events: checked(await native(original, room() + '/state')), name, nonce });
    await original.goto(ORIGIN + '/#room=' + encodeURIComponent(roomId)); await ready(original); await session(original, firstSession);
    stage = 'sending and backing up an actual encrypted message';
    const text = 'CI retained encrypted history ' + nonce;
    await original.getByRole('textbox', { name: 'Message ' + name, exact: true }).fill(text);
    const sent = await encryptedResponse(original, () => original.getByRole('button', { name: 'Send message', exact: true }).click());
    const eventId = await encryptedEvent(original, roomId, sent, text);
    const event = checked(await native(original, room() + '/event/' + encodeURIComponent(eventId)));
    assert.equal(event.sender, USER); assert.equal(event.type, 'm.room.encrypted');
    const sessionId = event.content?.session_id; assert.ok(typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 255);
    const keyPath = '/room_keys/keys/' + encodeURIComponent(roomId) + '/' + encodeURIComponent(sessionId) + '?version=' + encodeURIComponent(originalBackup.version);
    let uploaded = false;
    for (let attempt = 0; attempt < 90 && !uploaded; attempt++) {
      const value = await native(original, keyPath);
      if (value.status === 200) { assert.ok(typeof value.data.session_data?.ciphertext === 'string' && value.data.session_data.ciphertext); uploaded = true; }
      else assert.equal(value.status, 404);
      if (!uploaded) await pause(1000);
    }
    assert.ok(uploaded, 'The exact Megolm session must reach the encrypted native backup before the old device signs out.');
    await shown(original, eventId, text);
    const firstStore = 'harbor-crypto-' + USER + '-' + firstSession.deviceId + '::matrix-sdk-crypto';
    assert.ok((await stores(original)).includes(firstStore));
    stage = 'recovering after a managed new-device sign-in in the same browser';
    checked(await api(original, '/api/auth/logout', {}));
    await login(original, USERNAME, credential);
    const secondSession = await session(original); assert.notEqual(secondSession.deviceId, firstSession.deviceId);
    await shown(original, eventId, text);
    panel = await openSecurity(original);
    await expect(panel.locator('.local-history-recovery')).toContainText(/Recovered [1-9][0-9]* saved message keys/, { timeout: 60000 });
    assert.ok((await stores(original)).includes(firstStore), 'The source encryption database must survive recovery.');
    assert.deepEqual(await backup(original), originalBackup); assert.deepEqual(await signing(original), originalSigning);
    await closeSecurity(original); await original.context().close();
    console.log('PASS: a managed new-device login recovers an actual encrypted message from retained same-browser keys without replacing native identity or backup.');
    stage = 'opening a fresh browser with no retained history keys';
    const fresh = await freshPage(); await login(fresh, USERNAME, credential);
    const thirdSession = await session(fresh); assert.ok(![firstSession.deviceId, secondSession.deviceId].includes(thirdSession.deviceId));
    assert.deepEqual(await stores(fresh), ['harbor-crypto-' + USER + '-' + thirdSession.deviceId + '::matrix-sdk-crypto']);
    await fresh.goto(ORIGIN + '/#room=' + encodeURIComponent(roomId)); await ready(fresh);
    await expect(fresh.locator('article.message[id=' + JSON.stringify('message-' + eventId) + '] .message-body')).toContainText('Unable to decrypt', { timeout: 60000 });
    panel = await openSecurity(fresh);
    await expect(panel.getByLabel('Existing recovery key', { exact: true })).toBeVisible();
    stage = 'rejecting a wrong recovery key without resetting native security';
    const wrongKey = encodeRecoveryKey(randomBytes(32)); assert.ok(typeof wrongKey === 'string' && wrongKey !== recoveryKey);
    await panel.getByLabel('Existing recovery key', { exact: true }).fill(wrongKey);
    await panel.getByRole('button', { name: 'Unlock & enable automatic recovery', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('This recovery key does not match your account.');
    assert.deepEqual(await backup(fresh), originalBackup); assert.deepEqual(await signing(fresh), originalSigning);
    stage = 'restoring the encrypted native backup into the fresh device';
    await panel.getByLabel('Existing recovery key', { exact: true }).fill(recoveryKey);
    await panel.getByLabel('Restore every available history key now', { exact: true }).check();
    await panel.getByLabel('Finish interrupted setup or create a missing backup', { exact: true }).uncheck();
    await panel.getByRole('button', { name: 'Unlock & enable automatic recovery', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('Identity unlocked. Encrypted backup is active', { timeout: 120000 });
    await expect(panel.getByRole('alert')).toHaveCount(0);
    assert.deepEqual(await backup(fresh), originalBackup); assert.deepEqual(await signing(fresh), originalSigning);
    await closeSecurity(fresh); await shown(fresh, eventId, text);
    console.log('PASS: a fresh managed browser rejects a wrong key, preserves native backup/signing identity, and restores the real encrypted history using its saved recovery key.');
  } catch {
    // Playwright locator errors can quote fill() arguments. Never forward an
    // exception containing an account password or recovery key to CI logs.
    throw new Error('History recovery acceptance failed while ' + stage + '. Sensitive browser details were withheld.');
  } finally {
    credential = ''; recoveryKey = '';
    // The outer live runner prints open-page text on failure. Close these owned
    // contexts first so a generated key can never appear in that diagnostic.
    for (const page of owned) await page.context().close().catch(() => {});
  }
}
