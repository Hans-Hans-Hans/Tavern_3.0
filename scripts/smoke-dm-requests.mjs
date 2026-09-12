// Real native invitations and owning SDK clients on the isolated live stack.
// No application routes, crypto, account data, or browser responses are mocked.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isCiRoomId, assertCiRoomCreation } from './ci-room-id.mjs';
import { expect } from '@playwright/test';
import { matrixSmokeRequest, matrixSmokeCreateFixture, matrixSmokeInvite } from './matrix-smoke-request.mjs';

const ORIGIN = 'https://chat.example.test', ALICE = '@cialice:chat.example.test', BOB = '@cibob:chat.example.test';

const MODES = ['everyone', 'contacts', 'shared_server', 'nobody'];

export function assertDirectInvitationSync(data, id) {
  assert.ok(isCiRoomId(id));
  const events = data?.rooms?.invite?.[id]?.invite_state?.events;
  assert.ok(Array.isArray(events), 'The recipient initial sync must include the owned native invitation.');
  const self = events.filter(event => event.type === 'm.room.member' && event.state_key === BOB);
  assert.equal(self.length, 1, 'The recipient invite state must contain exactly one self membership.');
  assert.equal(self[0].sender === ALICE, true, 'The recipient invitation sender must match the known fixture creator.');
  assert.equal(self[0].content?.membership === 'invite', true, 'The recipient self membership must still be invited.');
  assert.equal(self[0].content?.is_direct === true, true, 'The recipient native invitation must retain the direct-message marker.');
}

export async function dmRequestsSmoke({ alice, bob, aliceSession, bobSession, origin, api, ready, encryptedResponse, encryptedEvent }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || origin !== ORIGIN || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls'
    || aliceSession?.userId !== ALICE || aliceSession.admin !== false || bobSession?.userId !== BOB || bobSession.admin !== false
    || !aliceSession.deviceId || !bobSession.deviceId || ![api, ready, encryptedResponse, encryptedEvent].every(value => typeof value === 'function')) {
    throw new Error('DM request acceptance requires the exact isolated CI origin and owning accounts.');
  }
  const nonce = randomBytes(12).toString('hex'), fixtures = new Map();
  const checked = (response, description) => {
    assert.equal(response.status, 200, description + ': ' + (response.data?.errcode || response.data?.error || 'unexpected status'));
    return response.data;
  };
  const session = async (page, expected) => {
    assert.equal(new URL(page.url()).origin, ORIGIN, 'Use only the isolated owning browser.');
    const current = checked(await matrixSmokeRequest(() => api(page, '/api/auth/session')), 'Read the owning CI session');
    assert.equal(current.userId, expected.userId); assert.equal(current.deviceId, expected.deviceId); assert.equal(current.admin, false);
  };
  const native = (page, path, body, method) => {
    assert.equal(new URL(page.url()).origin, ORIGIN);
    const request = () => api(page, '/_matrix/client/v3' + path, body, true, false, method);
    // Never replay createRoom: its invitation may fail after the room persists.
    return body === undefined || method === 'PUT' ? matrixSmokeRequest(request) : request();
  };
  const room = id => { assert.ok(fixtures.has(id) && isCiRoomId(id)); return '/rooms/' + encodeURIComponent(id); };
  const state = (id, type, key = '') => room(id) + '/state/' + encodeURIComponent(type) + '/' + encodeURIComponent(key);
  const membership = async id => checked(await native(alice, state(id, 'm.room.member', BOB)), 'Read Bob membership in the CI room').membership;
  const direct = async () => {
    const result = await native(bob, '/user/' + encodeURIComponent(BOB) + '/account_data/m.direct');
    if (result.status === 404 && result.data?.errcode === 'M_NOT_FOUND') return {};
    const value = checked(result, 'Read recipient native Messages mapping');
    assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value;
  };
  const inbox = () => bob.getByRole('region', { name: 'Message request inbox', exact: true });
  const row = id => inbox().getByRole('article', { name: 'Message request from ' + ALICE, exact: true }).filter({ hasText: id });
  const message = (page, eventId) => page.locator('article.message[id=' + JSON.stringify('message-' + eventId) + ']');
  const composer = page => page.locator('.conversation-main .composer textarea');
  async function inspect(id, expected) {
    await session(alice, aliceSession);
    const events = checked(await native(alice, room(id) + '/state'), 'Inspect the fresh CI direct room');
    assertCiRoomCreation({ id, events, creator: ALICE, name: fixtures.get(id), marker: 'io.tavern.ci_dm', runId: nonce, space: false });
    const content = type => events.find(event => event.type === type && event.state_key === '')?.content;
    const createEvent = events.find(event => event.type === 'm.room.create' && event.state_key === '');
    const create = createEvent?.content;
    // Modern room versions derive the creator from the event sender and omit
    // content.creator. Guard the actual native event in every room version.
    assert.equal(createEvent?.sender, ALICE); assert.equal(create['m.federate'], false);
    assert.equal(create['io.tavern.ci_dm'], nonce); assert.ok(!create.type);
    assert.equal(content('m.room.name').name, fixtures.get(id));
    assert.equal(content('m.room.encryption').algorithm, 'm.megolm.v1.aes-sha2');
    assert.equal(content('m.room.history_visibility').history_visibility, 'joined');
    assert.equal(content('m.room.join_rules').join_rule, 'invite');
    assert.deepEqual(events.filter(event => event.type === 'm.room.member').map(event => [event.state_key, event.content.membership]).sort(), [[ALICE, 'join'], ...(expected ? [[BOB, expected]] : [])].sort());
    if (expected === 'invite') {
      const invite = events.find(event => event.type === 'm.room.member' && event.state_key === BOB);
      assert.equal(invite.sender, ALICE); assert.equal(invite.content.is_direct, true);
    }
    assert.ok(!events.some(event => event.type === 'm.space.parent'));
  }
  async function create(suffix) {
    await session(alice, aliceSession); await session(bob, bobSession);
    const name = 'CI DM request ' + suffix + ' ' + nonce;
    const id = checked(await matrixSmokeCreateFixture(body => native(alice, '/createRoom', body), {
      name, visibility: 'private', preset: 'private_chat',
      creation_content: { 'm.federate': false, 'io.tavern.ci_dm': nonce },
      initial_state: [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
      ],
    }), 'Create one fresh direct invitation').room_id;
    assert.ok(isCiRoomId(id)); assert.ok(!fixtures.has(id)); fixtures.set(id, name);
    await inspect(id); // Prove the fresh native marker before inviting another account.
    checked(await matrixSmokeInvite(
      () => native(alice, state(id, 'm.room.member', BOB)),
      () => api(alice, '/_matrix/client/v3' + state(id, 'm.room.member', BOB), { membership: 'invite', is_direct: true }, true, false, 'PUT'),
    ), 'Persist the known native direct invitation');
    await inspect(id, 'invite'); return id;
  }
  async function openJoined(page, id) {
    room(id);
    await page.goto(ORIGIN + '/#room=' + encodeURIComponent(id)); await ready(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(composer(page)).toHaveCount(1); await expect(composer(page)).toBeEnabled();
  }
  async function send(page, id, text) {
    await session(page, page === alice ? aliceSession : bobSession);
    await composer(page).fill(text);
    const response = await encryptedResponse(page, () => page.getByRole('button', { name: 'Send message', exact: true }).click());
    return encryptedEvent(page, id, response, text);
  }
  await session(alice, aliceSession); await session(bob, bobSession);
  const savedPrivacy = checked(await api(bob, '/api/social/invitation-privacy'), 'Read CI recipient invitation preference').invitations;
  assert.ok(MODES.includes(savedPrivacy));
  let changedPrivacy = false, listener, failure;
  try {
    if (savedPrivacy !== 'everyone') {
      checked(await api(bob, '/api/social/invitation-privacy', { invitations: 'everyone' }, false, false, 'PUT'), 'Allow isolated test invitations');
      changedPrivacy = true;
    }
    const originalDirect = await direct();
    const accepted = await create('accept');
    await openJoined(alice, accepted);
    const beforeText = 'CI before acceptance ' + nonce;
    const beforeId = await send(alice, accepted, beforeText);
    const fileName = 'ci-before-acceptance-' + nonce + '.bin', bytes = Buffer.concat([Buffer.from('CI DM private attachment '), randomBytes(512)]);
    const [chooser] = await Promise.all([alice.waitForEvent('filechooser'), alice.getByRole('button', { name: 'Attach files (up to 10 MB each)', exact: true }).click()]);
    const [upload] = await Promise.all([
      alice.waitForResponse(response => response.request().method() === 'POST' && /\/_matrix\/(media|client)\/.*\/upload(?:\?|$)/.test(response.url())),
      chooser.setFiles({ name: fileName, mimeType: 'application/octet-stream', buffer: bytes }),
    ]);
    assert.equal(upload.status(), 200);
    const media = new URL((await upload.json()).content_uri);
    assert.equal(media.protocol, 'mxc:'); assert.equal(media.host, 'chat.example.test'); assert.match(media.pathname, /^\/[A-Za-z0-9_-]+$/);
    const stored = await api(alice, '/_matrix/client/v1/media/download/' + encodeURIComponent(media.host) + media.pathname, undefined, true, true);
    assert.equal(stored.status, 200); assert.ok(stored.data.length); assert.notDeepEqual(Buffer.from(stored.data), bytes);
    assert.ok(!Buffer.from(stored.data).includes(Buffer.from('CI DM private attachment ')));
    await expect(alice.locator('.pending-files')).toContainText(fileName);
    const encryptedFile = await encryptedResponse(alice, () => alice.getByRole('button', { name: 'Send message', exact: true }).click());
    const beforeFileId = await encryptedEvent(alice, accepted, encryptedFile, fileName);
    assert.equal(await membership(accepted), 'invite');
    const denied = await native(bob, room(accepted) + '/messages?dir=b&limit=10');
    assert.ok([403, 404].includes(denied.status), 'Native joined-only history must remain inaccessible to the invited recipient.');
    assert.ok(!JSON.stringify(denied.data).includes(beforeText));

    // Check the recipient's actual initial-sync representation as well as the
    // sender's persisted state. A sender-side invite alone does not establish
    // the stripped state available to the inbox after a browser reload.
    assertDirectInvitationSync(checked(await native(bob, '/sync?timeout=0'), 'Read the recipient native invitation state'), accepted);
    console.log('PASS: the recipient native initial sync contains the owned direct invitation and its sender marker.');

    const reads = [], mutations = [];
    let watch = accepted;
    listener = request => {
      const url = new URL(request.url()); if (url.origin !== ORIGIN) return;
      const path = decodeURIComponent(url.pathname);
      if (path.includes('/rooms/' + watch + '/') && /\/(messages|context|event|relations|threads)(?:\/|$)/.test(path)) reads.push(path);
      if (/\/media\/(?:(?:r0|v\d+)\/)?(?:download|thumbnail)\//.test(path) && path.endsWith(media.pathname)) reads.push(path);
      if (request.method() !== 'GET' && (path.includes('/join/' + watch) || path.includes('/rooms/' + watch + '/join') || path.includes('/rooms/' + watch + '/leave'))) mutations.push(path);
    };
    bob.on('request', listener);
    // Test the ordinary inbox and the invited-room deep link on real reload.
    await bob.goto(ORIGIN + '/'); await ready(bob);
    await bob.getByRole('button', { name: /^Message requests \(\d+\)$/ }).click();
    await expect(row(accepted)).toBeVisible({ timeout: 30000 });
    await expect(row(accepted).getByRole('button', { name: 'Accept message request', exact: true })).toBeEnabled();
    await expect(inbox().locator('img,video,audio,.message,.file-card')).toHaveCount(0);
    await expect(inbox()).not.toContainText(beforeText); await expect(inbox()).not.toContainText(fileName);
    await bob.goto(ORIGIN + '/#room=' + encodeURIComponent(accepted));
    // ready() requires an accessible home button, intentionally hidden by the inbox dialog.
    await expect(bob.locator('.connection')).toContainText('Connected', { timeout: 60000 });
    await expect(row(accepted)).toBeVisible();
    await expect(inbox().locator('img,video,audio,.message,.file-card')).toHaveCount(0);
    assert.equal(await membership(accepted), 'invite');
    assert.deepEqual(reads, [], 'Opening a request must not fetch its history or fixture media.');
    assert.deepEqual(mutations, [], 'Reviewing an invitation must not join or leave it.');
    assert.deepEqual(await direct(), originalDirect, 'Reviewing must not classify the recipient DM.');
    console.log('PASS: real direct invitations and deep links show no history/media, make no history/media requests, and preserve native invite membership.');

    // Only the explicit button may join. Subsequent repairs only save m.direct.
    bob.off('request', listener); listener = undefined;
    await session(bob, bobSession); await inspect(accepted, 'invite');
    await row(accepted).getByRole('button', { name: 'Accept message request', exact: true }).click();
    const repair = row(accepted).getByRole('button', { name: 'Retry adding to Messages', exact: true });
    await expect.poll(async () => (await inbox().count()) === 0 ? 'opened' : (await repair.isVisible()) ? 'repair' : 'waiting', { timeout: 60000 }).toMatch(/^(opened|repair)$/);
    // The response can precede joined sync. Retry only that documented local
    // classification gap, bounded by the existing page deadline. Other errors
    // fail the probe; never repeat Accept or manually replay the native join.
    if (await repair.isVisible()) await expect.poll(async () => {
      if ((await inbox().count()) === 0) return true;
      const alert = inbox().getByRole('alert');
      if (!(await repair.isVisible()) || !(await alert.count())) return false;
      assert.ok((await alert.textContent()).includes('Waiting for joined room state to sync.'), 'Only delayed joined sync permits a classification retry.');
      assert.equal(await membership(accepted), 'join');
      await session(bob, bobSession);
      if (await repair.isEnabled()) await repair.click();
      return (await inbox().count()) === 0;
    }, { timeout: 60000, intervals: [250, 500, 1000] }).toBe(true);
    await expect(inbox()).toHaveCount(0, { timeout: 60000 });
    await inspect(accepted, 'join');
    const merged = { ...originalDirect, [ALICE]: [...new Set([...(originalDirect[ALICE] || []), accepted])] };
    assert.deepEqual(await direct(), merged, 'Acceptance must preserve existing native DM mappings.');
    await expect(bob.locator('.dm-section .dm-link.active')).toBeVisible();
    await openJoined(bob, accepted); await session(bob, bobSession);
    assert.deepEqual(await direct(), merged, 'Recipient m.direct must persist across a real browser reload.');
    await expect(bob.locator('.dm-section .dm-link.active')).toBeVisible();
    await expect(message(bob, beforeId)).toHaveCount(0); await expect(message(bob, beforeFileId)).toHaveCount(0);
    const reply = 'CI accepted DM reply ' + nonce, replyId = await send(bob, accepted, reply);
    await expect(message(alice, replyId).locator('.message-body')).toContainText(reply, { timeout: 60000 });
    const answer = 'CI Alice accepted DM answer ' + nonce, answerId = await send(alice, accepted, answer);
    await expect(message(bob, answerId).locator('.message-body')).toContainText(answer, { timeout: 60000 });
    console.log('PASS: explicit acceptance joins, persists recipient m.direct after reload, and both owning SDKs decrypt new native encrypted messages.');

    const declined = await create('decline'); watch = declined; reads.length = 0; mutations.length = 0;
    listener = request => {
      const path = decodeURIComponent(new URL(request.url()).pathname);
      if (path.includes('/rooms/' + declined + '/') && /\/(messages|context|event|relations|threads)(?:\/|$)/.test(path)) reads.push(path);
      if (request.method() !== 'GET' && (path.includes('/join/' + declined) || path.includes('/rooms/' + declined + '/join'))) mutations.push(path);
    };
    bob.on('request', listener);
    await bob.getByRole('button', { name: /^Message requests \(\d+\)$/ }).click();
    await expect(row(declined)).toBeVisible(); await session(bob, bobSession); await inspect(declined, 'invite');
    await row(declined).getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(inbox().getByRole('status')).toHaveText('Message request declined.');
    await expect(row(declined)).toHaveCount(0); assert.equal(await membership(declined), 'leave');
    assert.deepEqual(await direct(), merged); assert.deepEqual(reads, []); assert.deepEqual(mutations, []);
    await bob.getByRole('dialog', { name: 'Message requests', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await bob.reload(); await ready(bob);
    await bob.getByRole('button', { name: /^Message requests \(\d+\)$/ }).click();
    await expect(row(declined)).toHaveCount(0); assert.equal(await membership(declined), 'leave');
    assert.deepEqual(await direct(), merged); assert.deepEqual(reads, []); assert.deepEqual(mutations, []);
    await bob.getByRole('dialog', { name: 'Message requests', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    console.log('PASS: declining a separate native direct invitation persists leave membership after reload without joining, classifying, or reading its messages.');
  } catch (error) { failure = error; }
  finally {
    if (listener) bob.off('request', listener);
    if (changedPrivacy) try {
      await session(bob, bobSession);
      checked(await api(bob, '/api/social/invitation-privacy', { invitations: savedPrivacy }, false, false, 'PUT'), 'Restore isolated recipient invitation preference');
    } catch { failure ||= new Error('Could not restore the isolated CI recipient invitation preference.'); }
  }
  if (failure) throw failure;
}
