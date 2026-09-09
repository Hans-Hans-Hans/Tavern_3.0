// Real HTTPS/account/Synapse/crypto acceptance test; no network routes are mocked.
import { chromium, expect } from '@playwright/test';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { privateDiscussionSmoke } from './smoke-private-discussions.mjs';

if (process.env.TAVERN_CI_SMOKE !== 'true') throw new Error('Live smoke runs only on the isolated CI stack.');
if (!process.env.TAVERN_CI_TLS) throw new Error('The isolated CI certificate directory is required.');
// Playwright ignoreHTTPSErrors does not cover service-worker installation.
// Trust only this run's ephemeral public key, including worker fetches.
const certificate = new X509Certificate(await readFile(join(process.env.TAVERN_CI_TLS, 'cert.pem')));
const fingerprint = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
const origin = 'https://chat.example.test';
const password = () => 'Ci!' + randomBytes(24).toString('base64url');
const adminPassword = password(), alicePassword = password(), bobPassword = password();
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP chat.example.test 127.0.0.1', '--no-proxy-server', '--ignore-certificate-errors-spki-list=' + fingerprint] });
const pages = [], errors = [];
async function page() {
  const context = await browser.newContext();
  const value = await context.newPage(); value.setDefaultTimeout(60000);
  value.on('pageerror', error => errors.push(error.message));
  value.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 2000)); });
  value.on('response', response => { if (response.status() >= 400) errors.push(response.status() + ' ' + response.request().method() + ' ' + new URL(response.url()).pathname); });
  pages.push(value); return value;
}
async function api(page, path, body, matrix = false, binary = false, method) {
  return page.evaluate(async ({ path, body, matrix, binary, method }) => {
    const session = await (await fetch('/api/auth/session', { cache: 'no-store' })).json();
    const headers = { 'Content-Type': 'application/json', 'X-Tavern-Device': session.deviceId };
    if (matrix) headers.Authorization = 'Bearer cookie-session:' + session.deviceId;
    const response = await fetch((matrix ? '/api/matrix' : '') + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers, cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: binary ? Array.from(new Uint8Array(await response.arrayBuffer())) : await response.json() };
  }, { path, body, matrix, binary, method });
}
async function ready(page) {
  // The first-run dialog aria-hides the page behind it, so use its visual shell
  // for the initial wait and dismiss onboarding before querying page roles.
  await page.locator('.workspace-rail').waitFor();
  await expect(page.locator('.connection')).toContainText('Connected', { timeout: 60000 });
  const finish = page.getByRole('button', { name: 'Finish later', exact: true });
  if (await finish.isVisible()) await finish.click();
  await expect(page.getByRole('button', { name: 'Tavern home', exact: true })).toBeVisible();
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.active, undefined, { timeout: 15000 });
  await expect(page.getByText('Offline app storage is unavailable.', { exact: false })).toHaveCount(0);
  await expect(page.getByText('An app update is ready', { exact: true })).toHaveCount(0);
}
async function login(page, username, password) {
  await page.goto(origin);
  await page.getByLabel('Username or email', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await ready(page);
}
function message(page, eventId) {
  return page.locator('article.message[id=' + JSON.stringify('message-' + eventId) + ']');
}
async function responseDuring(page, predicate, action) {
  // Attach both rejection handlers immediately so a missing response cannot
  // terminate Node before the browser diagnostics in the outer catch run.
  const [response] = await Promise.all([page.waitForResponse(predicate), action()]);
  return response;
}
function encryptedResponse(page, action) {
  return responseDuring(page, response => response.request().method() === 'PUT' && response.url().includes('/send/m.room.encrypted/'), action);
}
async function encryptedEvent(page, roomId, response, plaintext) {
  assert.equal(response.status(), 200);
  const { event_id: eventId } = await response.json();
  const stored = await api(page, '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/event/' + encodeURIComponent(eventId), undefined, true);
  assert.equal(stored.status, 200); assert.equal(stored.data.type, 'm.room.encrypted');
  assert.ok(stored.data.content.ciphertext); assert.ok(!JSON.stringify(stored.data).includes(plaintext));
  return eventId;
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
  console.log('PASS: administrator setup verifies email through TLS SMTP and creates a secure HttpOnly session.');
  for (const [username, displayName, credential] of [['cialice', 'CI Alice', alicePassword], ['cibob', 'CI Bob', bobPassword]]) {
    const result = await api(admin, '/api/admin/users', { username, displayName, password: credential });
    assert.equal(result.status, 201, 'An administrator must be able to create ordinary accounts: ' + JSON.stringify(result.data));
  }
  const alice = await page(), bob = await page();
  await login(alice, 'cialice', alicePassword); await login(bob, 'cibob', bobPassword);
  const aliceSession = (await api(alice, '/api/auth/session')).data, bobSession = (await api(bob, '/api/auth/session')).data;
  assert.equal(aliceSession.admin, false); assert.equal(bobSession.admin, false);
  assert.equal((await api(alice, '/api/admin/users')).status, 403);
  console.log('PASS: two ordinary accounts sign in and administrator endpoints reject their sessions.');
  // Create the encrypted test fixture through the same authenticated native
  // Matrix gateway; actual sending/decryption below uses the production UI/SDK.
  const created = await api(alice, '/_matrix/client/v3/createRoom', { name: 'CI encrypted conversation', preset: 'private_chat', invite: [bobSession.userId], creation_content: { 'm.federate': false }, initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] }, true);
  assert.equal(created.status, 200, JSON.stringify(created.data)); const roomId = created.data.room_id;
  assert.equal((await api(bob, '/_matrix/client/v3/join/' + encodeURIComponent(roomId), {}, true)).status, 200);
  for (const participant of [alice, bob]) { await participant.goto(origin + '/#room=' + encodeURIComponent(roomId)); await ready(participant); }
  const text = 'Encrypted CI proof ' + randomBytes(12).toString('hex');
  console.log('Ready to send an encrypted message from the production composer.');
  await alice.getByRole('textbox', { name: 'Message CI encrypted conversation', exact: true }).fill(text);
  await expect(alice.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  const encryptedSend = await encryptedResponse(alice, () => alice.getByRole('button', { name: 'Send message', exact: true }).click({ timeout: 15000 }));
  const eventId = await encryptedEvent(alice, roomId, encryptedSend, text);
  await expect(bob.locator('.message-body').filter({ hasText: text })).toBeVisible({ timeout: 60000 });
  await bob.reload(); await ready(bob);
  assert.equal((await api(bob, '/api/auth/session')).data.deviceId, bobSession.deviceId);
  await expect(bob.locator('.message-body').filter({ hasText: text })).toBeVisible({ timeout: 60000 });
  await bob.getByRole('button', { name: 'Your profile', exact: true }).click();
  await expect(bob.locator('.community-profile-form').getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue('CI Bob');
  await bob.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  console.log('PASS: real HTTPS administrator email verification, ordinary account login, server authorization, encrypted two-user messaging, same-device reload decryption, and native profile hydration.');

  const aliceMessage = message(alice, eventId), bobMessage = message(bob, eventId);
  const edited = text + ' edited';
  await aliceMessage.hover();
  await aliceMessage.getByRole('button', { name: 'More message actions', exact: true }).click();
  await alice.getByRole('menuitem', { name: 'Edit message', exact: true }).click();
  await aliceMessage.getByRole('textbox', { name: 'Edit message text', exact: true }).fill(edited);
  const encryptedEdit = await encryptedResponse(alice, () => aliceMessage.getByRole('button', { name: 'Save', exact: true }).click());
  await encryptedEvent(alice, roomId, encryptedEdit, edited);
  await expect(bobMessage.locator('.message-body')).toHaveText(edited);
  await expect(bobMessage.locator('.edited')).toBeVisible();

  await bobMessage.hover();
  await bobMessage.getByRole('button', { name: 'Add reaction', exact: true }).click();
  await bob.getByRole('searchbox', { name: 'Search emoji', exact: true }).fill('thumbs up');
  const reacted = await responseDuring(bob, response => response.request().method() === 'PUT' && response.url().includes('/send/m.reaction/'), () => bob.getByRole('button', { name: 'thumbs up like yes', exact: true }).click());
  assert.equal(reacted.status(), 200);
  await bob.keyboard.press('Escape');
  await expect(aliceMessage.getByRole('button', { name: 'View 1 people reacting with 👍', exact: true })).toBeVisible();

  const threadText = 'Encrypted thread proof ' + randomBytes(12).toString('hex');
  await bobMessage.hover();
  await bobMessage.getByRole('button', { name: 'Reply in thread', exact: true }).click();
  await bob.getByRole('textbox', { name: 'Message this thread', exact: true }).fill(threadText);
  const encryptedThread = await encryptedResponse(bob, () => bob.locator('.thread-sheet').getByRole('button', { name: 'Send message', exact: true }).click());
  await encryptedEvent(bob, roomId, encryptedThread, threadText);
  await expect(aliceMessage.getByRole('button', { name: '1 reply View thread', exact: true })).toBeVisible();
  await aliceMessage.getByRole('button', { name: '1 reply View thread', exact: true }).click();
  await expect(alice.locator('.thread-sheet .message-body').filter({ hasText: threadText })).toBeVisible();
  for (const participant of [alice, bob]) await participant.locator('.thread-sheet').getByRole('button', { name: 'Close', exact: true }).click();
  console.log('PASS: encrypted edits and thread replies decrypt for the other user; reactions synchronize.');

  const fileName = 'ci-encrypted-proof.bin', fileBytes = Buffer.concat([Buffer.from('Tavern private file proof '), randomBytes(4096)]);
  const [chooser] = await Promise.all([alice.waitForEvent('filechooser'), alice.getByRole('button', { name: 'Attach files (up to 10 MB each)', exact: true }).click()]);
  const upload = await responseDuring(alice, response => response.request().method() === 'POST' && /\/_matrix\/(media|client)\/.*\/upload(?:\?|$)/.test(response.url()), () => chooser.setFiles({ name: fileName, mimeType: 'application/octet-stream', buffer: fileBytes }));
  assert.equal(upload.status(), 200);
  // Chromium does not expose every Blob upload through postDataBuffer(). Read
  // the actual stored media bytes through the authenticated Matrix endpoint.
  const media = new URL((await upload.json()).content_uri);
  assert.equal(media.protocol, 'mxc:');
  const storedMedia = await api(alice, '/_matrix/client/v1/media/download/' + encodeURIComponent(media.host) + '/' + encodeURIComponent(media.pathname.slice(1)), undefined, true, true);
  assert.equal(storedMedia.status, 200);
  const storedBytes = Buffer.from(storedMedia.data);
  assert.ok(storedBytes.length, 'Synapse must store encrypted file bytes.');
  assert.notDeepEqual(storedBytes, fileBytes); assert.ok(!storedBytes.includes(Buffer.from('Tavern private file proof ')));
  await expect(alice.locator('.pending-files')).toContainText(fileName);
  const encryptedFile = await encryptedResponse(alice, () => alice.getByRole('button', { name: 'Send message', exact: true }).click());
  await encryptedEvent(alice, roomId, encryptedFile, fileName);
  console.log('PASS: Synapse stores the uploaded file as ciphertext and the attachment event is encrypted.');
  const fileCard = bob.locator('.file-card').filter({ hasText: fileName });
  await fileCard.click();
  await expect(bob.locator('.media-viewport')).toContainText('A preview is not available for this file.', { timeout: 15000 });
  const saveFile = bob.getByRole('dialog').getByRole('link', { name: 'Download', exact: true });
  await expect(saveFile).toHaveAttribute('href', /^blob:/);
  await expect(saveFile).toHaveAttribute('download', fileName);
  const [download] = await Promise.all([bob.waitForEvent('download'), saveFile.click()]);
  assert.equal(download.suggestedFilename(), fileName);
  const stream = await download.createReadStream(), chunks = [];
  assert.ok(stream, 'The receiving user must be able to download the decrypted file.');
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), fileBytes);
  console.log('PASS: Synapse stores the uploaded file as ciphertext and it decrypts byte-for-byte for the receiving user.');

  await bob.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await alice.getByRole('button', { name: 'Your profile', exact: true }).click();
  const profileForm = alice.locator('.community-profile-form');
  await expect(profileForm.getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue('CI Alice');
  const avatarPng = Buffer.from(await alice.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext('2d');
    context.fillStyle = '#3456aa'; context.fillRect(0, 0, 64, 64);
    context.fillStyle = '#f0cf55'; context.fillRect(16, 16, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await profileForm.getByLabel('Choose avatar', { exact: true }).setInputFiles({ name: 'ci-avatar.png', mimeType: 'image/png', buffer: avatarPng });
  await expect(profileForm.getByRole('img', { name: 'Crop preview', exact: true })).toBeVisible();
  const avatarUpload = await responseDuring(alice,
    response => response.request().method() === 'POST' && /\/_matrix\/(media|client)\/.*\/upload(?:\?|$)/.test(response.url()),
    () => profileForm.getByRole('button', { name: 'Use cropped image', exact: true }).click());
  assert.equal(avatarUpload.status(), 200);
  const avatarUri = (await avatarUpload.json()).content_uri;
  const ownAvatar = profileForm.getByRole('img', { name: 'Avatar', exact: true });
  await expect(ownAvatar).toHaveAttribute('src', /^blob:/);
  await ownAvatar.scrollIntoViewIfNeeded();
  await expect.poll(() => ownAvatar.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await profileForm.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(alice.getByText('Profile saved', { exact: true })).toBeVisible();
  assert.equal((await api(alice, '/_matrix/client/v3/profile/' + encodeURIComponent(aliceSession.userId) + '/avatar_url', undefined, true)).data.avatar_url, avatarUri);
  assert.equal((await api(alice, '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/state/m.room.member/' + encodeURIComponent(aliceSession.userId), undefined, true)).data.avatar_url, avatarUri);
  await alice.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await bob.reload(); await ready(bob);
  const sharedAvatar = bob.getByRole('button', { name: 'View CI Alice profile', exact: true }).first().getByRole('img', { name: 'CI Alice', exact: true });
  await expect(sharedAvatar).toHaveAttribute('src', /^blob:/);
  await sharedAvatar.scrollIntoViewIfNeeded();
  await expect.poll(() => sharedAvatar.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  console.log('PASS: a cropped profile avatar uploads, persists in the account and room, and loads through authenticated thumbnails for another user after reload.');
  await privateDiscussionSmoke({ admin, alice, bob, adminSession, aliceSession, bobSession, origin, api, encryptedResponse, encryptedEvent });
} catch (error) {
  console.error('Live browser errors:', errors);
  for (const [index, page] of pages.entries()) console.error('Page ' + index + ':', await page.locator('body').innerText().catch(() => 'unavailable'));
  throw error;
} finally { await browser.close(); }
