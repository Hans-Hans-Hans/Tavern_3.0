// Real HTTPS/account/Synapse/crypto acceptance test; no network routes are mocked.
import { chromium, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

if (process.env.TAVERN_CI_SMOKE !== 'true') throw new Error('Live smoke runs only on the isolated CI stack.');
const origin = 'https://chat.example.test';
const password = () => 'Ci!' + randomBytes(24).toString('base64url');
const adminPassword = password(), alicePassword = password(), bobPassword = password();
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP chat.example.test 127.0.0.1', '--no-proxy-server'] });
const pages = [], errors = [];
async function page() {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const value = await context.newPage(); value.setDefaultTimeout(60000);
  value.on('pageerror', error => errors.push(error.message)); pages.push(value); return value;
}
async function api(page, path, body, matrix = false) {
  return page.evaluate(async ({ path, body, matrix }) => {
    const session = await (await fetch('/api/auth/session', { cache: 'no-store' })).json();
    const headers = { 'Content-Type': 'application/json', 'X-Tavern-Device': session.deviceId };
    if (matrix) headers.Authorization = 'Bearer cookie-session:' + session.deviceId;
    const response = await fetch((matrix ? '/api/matrix' : '') + path, { method: body === undefined ? 'GET' : 'POST', headers, cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }, { path, body, matrix });
}
async function ready(page) {
  await page.getByRole('button', { name: 'Tavern home', exact: true }).waitFor();
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 60000 });
  const finish = page.getByRole('button', { name: 'Finish later', exact: true });
  if (await finish.isVisible()) await finish.click();
  await expect(page.getByRole('button', { name: 'Tavern home', exact: true })).toBeVisible();
}
async function login(page, username, password) {
  await page.goto(origin);
  await page.getByLabel('Username or email', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await ready(page);
}
try {
  const admin = await page(); await admin.goto(origin);
  await admin.getByRole('heading', { name: 'Administrator setup', exact: true }).waitFor();
  await admin.getByLabel('Administrator username', { exact: true }).fill('ciadmin');
  await admin.getByLabel('Display name', { exact: true }).fill('CI Administrator');
  await admin.getByLabel('Email', { exact: true }).fill('ciadmin@example.test');
  await admin.getByLabel('New password', { exact: true }).fill(adminPassword);
  await admin.getByLabel('Confirm password', { exact: true }).fill(adminPassword);
  await admin.getByRole('button', { name: 'Send verification code', exact: true }).click();
  await admin.getByLabel('Verification code', { exact: true }).waitFor();
  let code;
  for (let attempt = 0; attempt < 40 && !code; attempt++) {
    const mail = await (await fetch('http://127.0.0.1:18085/messages')).json();
    const message = mail.messages.findLast(message => message.to === 'ciadmin@example.test' && message.subject.includes('Verify your administrator'));
    code = message?.text.match(/setup code is (\d{6})/)?.[1];
    if (!code) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(code, 'Administrator verification must arrive through the TLS SMTP service.');
  await admin.getByLabel('Verification code', { exact: true }).fill(code);
  await admin.getByRole('button', { name: 'Verify and continue', exact: true }).click();
  await ready(admin);
  const adminSession = (await api(admin, '/api/auth/session')).data;
  assert.equal(adminSession.admin, true); assert.equal(adminSession.emailVerified, true);
  assert.equal((await api(admin, '/api/auth/config')).data.bootstrapRequired, false);
  const cookie = (await admin.context().cookies()).find(cookie => cookie.httpOnly);
  assert.ok(cookie?.secure, 'The authenticated session must use a secure HttpOnly cookie.');
  for (const [username, displayName, credential] of [['cialice', 'CI Alice', alicePassword], ['cibob', 'CI Bob', bobPassword]]) {
    const result = await api(admin, '/api/admin/users', { username, displayName, password: credential });
    assert.equal(result.status, 201, 'An administrator must be able to create ordinary accounts: ' + JSON.stringify(result.data));
  }
  const alice = await page(), bob = await page();
  await login(alice, 'cialice', alicePassword); await login(bob, 'cibob', bobPassword);
  const aliceSession = (await api(alice, '/api/auth/session')).data, bobSession = (await api(bob, '/api/auth/session')).data;
  assert.equal(aliceSession.admin, false); assert.equal(bobSession.admin, false);
  assert.equal((await api(alice, '/api/admin/users')).status, 403);
  // Create the encrypted test fixture through the same authenticated native
  // Matrix gateway; actual sending/decryption below uses the production UI/SDK.
  const created = await api(alice, '/_matrix/client/v3/createRoom', { name: 'CI encrypted conversation', preset: 'private_chat', invite: [bobSession.userId], creation_content: { 'm.federate': false }, initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] }, true);
  assert.equal(created.status, 200, JSON.stringify(created.data)); const roomId = created.data.room_id;
  assert.equal((await api(bob, '/_matrix/client/v3/join/' + encodeURIComponent(roomId), {}, true)).status, 200);
  for (const participant of [alice, bob]) { await participant.goto(origin + '/#room=' + encodeURIComponent(roomId)); await ready(participant); }
  const text = 'Encrypted CI proof ' + randomBytes(12).toString('hex');
  const encryptedSend = alice.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/send/m.room.encrypted/'));
  await alice.getByRole('textbox', { name: 'Message CI encrypted conversation', exact: true }).fill(text);
  await alice.getByRole('button', { name: 'Send message', exact: true }).click();
  const sent = await encryptedSend; assert.equal(sent.status(), 200);
  const { event_id: eventId } = await sent.json();
  await expect(bob.locator('.message-body').filter({ hasText: text })).toBeVisible({ timeout: 60000 });
  const stored = await api(alice, '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/event/' + encodeURIComponent(eventId), undefined, true);
  assert.equal(stored.status, 200); assert.equal(stored.data.type, 'm.room.encrypted');
  assert.ok(stored.data.content.ciphertext); assert.ok(!JSON.stringify(stored.data).includes(text));
  await bob.reload(); await ready(bob);
  assert.equal((await api(bob, '/api/auth/session')).data.deviceId, bobSession.deviceId);
  await expect(bob.locator('.message-body').filter({ hasText: text })).toBeVisible({ timeout: 60000 });
  console.log('PASS: real HTTPS administrator email verification, ordinary account login, server authorization, encrypted two-user messaging, and same-device reload decryption.');
} catch (error) {
  console.error('Live browser errors:', errors);
  for (const [index, page] of pages.entries()) console.error('Page ' + index + ':', await page.locator('body').innerText().catch(() => 'unavailable'));
  throw error;
} finally { await browser.close(); }
