// Real HTTPS/account/Synapse/crypto acceptance test; no network routes are mocked.
import { chromium, expect } from '@playwright/test';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { privateDiscussionSmoke } from './smoke-private-discussions.mjs';
import { historyRecoverySmoke } from './smoke-history-recovery.mjs';
import { afkSmoke } from './smoke-afk.mjs';
import { eligibilitySmoke } from './smoke-eligibility.mjs';
import { profilePolicySmoke } from './smoke-profile-policy.mjs';
import { systemMessagesSmoke } from './smoke-system-messages.mjs';
import { dmRequestsSmoke } from './smoke-dm-requests.mjs';
import { invitationPrivacySmoke } from './smoke-invitation-privacy.mjs';
import { channelAdmissionSmoke } from './smoke-channel-admission.mjs';
import { roomRemovalSmoke } from './smoke-room-removal.mjs';
import { gamesWorkflowSmoke } from './smoke-games-workflow.mjs';
import { roleMentionsSmoke } from './smoke-role-mentions.mjs';
import { callAudioSmoke } from './smoke-call-audio.mjs';
import { rtcAuthSmoke } from './smoke-rtc-auth.mjs';
import { conferenceSmoke } from './smoke-conference.mjs';
import { directAudioSmoke, DirectAudioAcceptanceError } from './smoke-direct-audio.mjs';
import { memberModerationSmoke } from './smoke-member-moderation.mjs';
import { deactivationSmoke } from './smoke-deactivation.mjs';
import { matrixSmokeRequest } from './matrix-smoke-request.mjs';
import { dismissOptionalOnboarding } from './smoke-workspace-ready.mjs';

if (process.env.TAVERN_CI_SMOKE !== 'true') throw new Error('Live smoke runs only on the isolated CI stack.');
if (!process.env.TAVERN_CI_TLS) throw new Error('The isolated CI certificate directory is required.');
// Playwright ignoreHTTPSErrors does not cover service-worker installation.
// Trust only this run's ephemeral public key, including worker fetches.
const certificate = new X509Certificate(await readFile(join(process.env.TAVERN_CI_TLS, 'cert.pem')));
const fingerprint = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
const origin = 'https://chat.example.test';
const password = () => 'Ci!' + randomBytes(24).toString('base64url');
const adminPassword = password(), alicePassword = password(), bobPassword = password();
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP chat.example.test 127.0.0.1', '--no-proxy-server', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors-spki-list=' + fingerprint] });
const pages = [], errors = [];
const directFailures = [];
let conferenceProbe = false;
function browserError(text, exception = false) {
  // Keep late startup failures visible even while the native conference probe
  // suppresses its potentially credential-bearing SDK log arguments.
  const categories = [
    [/Failed to process events on room/, 'Matrix room event processing failed'],
    [/read.?only property/i, 'Read-only event property'],
    [/Cannot (?:read|set) propert|can.t access property/i, 'Unavailable object property'],
    [/not defined/, 'Undefined reference'],
    [/Maximum call stack|too much recursion/i, 'Recursive observer'],
  ].filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  errors.push(conferenceProbe ? (exception ? 'Browser exception' : 'Browser console error') + (categories.length ? ': ' + categories.join(', ') : ' (see bounded probe result)') : text.slice(0, 2000));
  if (errors.length > 200) errors.splice(0, errors.length - 200);
}
async function page() {
  const context = await browser.newContext();
  const value = await context.newPage(); value.setDefaultTimeout(60000);
  value.on('pageerror', error => browserError(error.message, true));
  value.on('console', message => { if (message.type() === 'error') browserError(message.text()); });
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
  await dismissOptionalOnboarding(page);
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
  let transaction;
  return responseDuring(page, async response => {
    if (response.request().method() !== 'PUT' || !response.url().includes('/send/m.room.encrypted/')) return false;
    transaction ||= response.url();
    if (response.url() !== transaction) return false;
    if (response.status() !== 429) return true;
    const data = await response.json().catch(() => null), delay = data?.retry_after_ms;
    // Observe the SDK's retry of this same transaction. Never click Send again
    // or replay its request; other failures and the page deadline still fail.
    return !(data?.errcode === 'M_LIMIT_EXCEEDED' && Number.isInteger(delay) && delay >= 0 && delay <= 30000);
  }, action);
}
async function encryptedEvent(page, roomId, response, plaintext) {
  assert.equal(response.status(), 200);
  const { event_id: eventId } = await response.json();
  const stored = await matrixSmokeRequest(() => api(page, '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/event/' + encodeURIComponent(eventId), undefined, true));
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
  // Validate fresh-device encrypted delivery before the independent media
  // workload. A call failure must not hide the bot's native key-delivery result.
  await systemMessagesSmoke({ admin, alice, bob, adminSession, aliceSession, bobSession, origin, api, ready, createPage: page, login });
  // Create the encrypted test fixture through the same authenticated native
  // Matrix gateway; actual sending/decryption below uses the production UI/SDK.
  const created = await api(alice, '/_matrix/client/v3/createRoom', { name: 'CI encrypted conversation', preset: 'private_chat', invite: [bobSession.userId], creation_content: { 'm.federate': false }, power_level_content_override: { events: { 'org.matrix.msc3401.call.member': 0 } }, initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] }, true);
  assert.equal(created.status, 200, JSON.stringify(created.data)); const roomId = created.data.room_id;
  assert.equal((await api(bob, '/_matrix/client/v3/join/' + encodeURIComponent(roomId), {}, true)).status, 200);
  for (const participant of [alice, bob]) { await participant.goto(origin + '/#room=' + encodeURIComponent(roomId)); await ready(participant); }
  await channelAdmissionSmoke({ alice, bob, aliceSession, bobSession, origin, api });
  await roomRemovalSmoke({ alice, aliceSession, origin, api });
  for (const participant of [alice, bob]) { await participant.goto(origin + '/#room=' + encodeURIComponent(roomId)); await ready(participant); }
  await rtcAuthSmoke({ alice, bob, aliceSession, bobSession, roomId, origin, api });
  conferenceProbe = true;
  try {
    for (const participant of [alice, bob]) await participant.context().grantPermissions(['microphone', 'camera'], { origin });
    await conferenceSmoke({ alice, bob, aliceSession, bobSession, roomId, origin, api });
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await directAudioSmoke({alice,bob,aliceSession,bobSession,roomId,origin,api,ready}); }
      catch (failure) {
        if (!(failure instanceof DirectAudioAcceptanceError) || !failure.cleanupConfirmed) throw failure;
        directFailures.push(failure.message); console.error('FAIL: direct call ' + (attempt + 1) + ': ' + failure.message);
      }
    }
  } finally {
    for (const participant of [alice, bob]) await participant.context().clearPermissions();
    conferenceProbe = false;
  }
  conferenceProbe = true;
  try {
    for (const participant of [alice, bob]) await participant.context().grantPermissions(['microphone', 'camera'], { origin });
    await gamesWorkflowSmoke({ alice, bob, aliceSession, bobSession, origin, api, ready });
  } finally {
    for (const participant of [alice, bob]) await participant.context().clearPermissions();
    conferenceProbe = false;
  }
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
  let thumbnailRequests = 0; const thumbnailStatuses = [];
  const isThumbnail = url => new URL(url).pathname.startsWith('/api/matrix/_matrix/client/v1/media/thumbnail/');
  const thumbnailRequest = request => { if (isThumbnail(request.url())) thumbnailRequests = Math.min(100, thumbnailRequests + 1); };
  const thumbnailResponse = response => { if (isThumbnail(response.url()) && thumbnailStatuses.length < 20) thumbnailStatuses.push(response.status()); };
  bob.on('request', thumbnailRequest); bob.on('response', thumbnailResponse);
  try {
    await bob.reload(); await ready(bob);
    const sharedAvatar = bob.getByRole('button', { name: 'View CI Alice profile', exact: true }).first().getByRole('img', { name: 'CI Alice', exact: true });
    await expect(sharedAvatar).toHaveAttribute('src', /^blob:/);
    await sharedAvatar.scrollIntoViewIfNeeded();
    await expect.poll(() => sharedAvatar.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  } catch (failure) {
    const member = await api(bob, '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/state/m.room.member/' + encodeURIComponent(aliceSession.userId), undefined, true).catch(() => null);
    console.error('Avatar acceptance diagnostics:', JSON.stringify({ nativeMembershipReadable: member?.status === 200, nativeAvatarMatches: member?.data?.avatar_url === avatarUri, thumbnailRequests, thumbnailStatuses }));
    throw failure;
  } finally { bob.off('request', thumbnailRequest); bob.off('response', thumbnailResponse); }
  console.log('PASS: a cropped profile avatar uploads, persists in the account and room, and loads through authenticated thumbnails for another user after reload.');
  await historyRecoverySmoke({ admin, adminSession, origin, api, ready, createPage: page, login, encryptedResponse, encryptedEvent });
  await privateDiscussionSmoke({ admin, alice, bob, adminSession, aliceSession, bobSession, origin, api, encryptedResponse, encryptedEvent });
  const afkFixture = await afkSmoke({ admin, alice, adminSession, aliceSession, api });
  await eligibilitySmoke({ admin, alice, adminSession, aliceSession, fixture: afkFixture, encryptedProbe: { roomId, eventId }, origin, api, ready, encryptedResponse, encryptedEvent });
  await profilePolicySmoke({ admin, alice, adminSession, aliceSession, fixture: afkFixture, origin, api });
  await dmRequestsSmoke({ alice, bob, aliceSession, bobSession, origin, api, ready, encryptedResponse, encryptedEvent });
  await invitationPrivacySmoke({ admin, bob, adminSession, bobSession, origin, api, createPage: page, login });
  await roleMentionsSmoke({ alice, bob, aliceSession, bobSession, origin, api, ready, encryptedResponse, encryptedEvent });
  await memberModerationSmoke({ admin, alice, bob, adminSession, aliceSession, bobSession, origin, api });
  await callAudioSmoke({ admin, alice, bob, adminSession, aliceSession, bobSession, origin, api });
  await deactivationSmoke({ admin, alice, bob, aliceSession, bobSession, bobPassword, origin, api, ready });
  if (directFailures.length) throw new Error('Native direct-call validation failed in ' + directFailures.length + ' of 3 calls. See the bounded diagnostics above; independent native checks ran only after confirmed call cleanup.');
} catch (error) {
  console.error('Live browser errors (latest 100):', JSON.stringify(errors.slice(-100)));
  for (const [index, page] of pages.entries()) console.error('Page ' + index + ':', await page.locator('body').innerText().catch(() => 'unavailable'));
  throw error;
} finally { await browser.close(); }
