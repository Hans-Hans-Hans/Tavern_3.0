// Actual native role state, the shipped composer, and two owning SDK decryptors.
// The caller supplies the existing isolated HTTPS browser/API helpers; no routes
// or cryptographic operations are mocked or replaced.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { expect } from '@playwright/test';
import { matrixSmokeCreateFixture, matrixSmokeInvite, matrixSmokeJoin, matrixSmokeRequest } from './matrix-smoke-request.mjs';

const ORIGIN = 'https://chat.example.test', ALICE = '@cialice:chat.example.test', BOB = '@cibob:chat.example.test';
const ROLES = 'io.tavern.roles', MARKER = 'io.tavern.ci_role_mentions';
// Native v12 hashes have no server suffix. Locality is established by the
// owning session, fresh returned-ID registry and inspected creation event.
const HASH_ROOM = /^![A-Za-z0-9_-]{43}$/;
const ROOM = /^(?:![A-Za-z0-9_-]{43}|![^\s/\\?#:]{1,200}:chat\.example\.test)$/;
const MODES = ['everyone', 'contacts', 'shared_server', 'nobody'];
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());

// Room v12 gives the creation sender inherent power; its explicit users map
// deliberately need not contain the creator. Do not force an older room version.
export function assertRoleFixtureAuthority(create, powers) {
  assert.equal(create?.sender, ALICE);
  assert.deepEqual(create.content.additional_creators ?? [], [], 'The fixture must not grant any additional creator authority.');
  const actorPower = create.content.room_version === '12' ? Infinity : powers.users?.[ALICE] ?? powers.users_default ?? 0;
  const bobPower = powers.users?.[BOB] ?? powers.users_default ?? 0;
  if (create.content.room_version !== '12') assert.equal(actorPower, 100);
  assert.equal(bobPower, 0);
  assert.ok(actorPower > bobPower && actorPower >= (powers.events?.[ROLES] ?? powers.state_default ?? 50));
}

export async function roleMentionsSmoke({ alice, bob, aliceSession, bobSession, origin, api, ready, encryptedResponse, encryptedEvent }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls' || origin !== ORIGIN
    || aliceSession?.userId !== ALICE || aliceSession.admin !== false || !aliceSession.deviceId
    || bobSession?.userId !== BOB || bobSession.admin !== false || !bobSession.deviceId
    || ![api, ready, encryptedResponse, encryptedEvent].every(value => typeof value === 'function')) {
    throw new Error('Role mention acceptance requires the exact isolated CI origin and owning accounts.');
  }
  assert.notEqual(alice, bob, 'Two distinct owning browsers are required.');
  assert.notEqual(alice.context(), bob.context(), 'Each owning account must have its own browser context.');
  const nonce = randomBytes(12).toString('hex'), fixtures = new Map(), proofs = [];
  const checked = (response, description) => {
    assert.equal(response.status, 200, description + ': ' + (response.data?.errcode || 'unexpected status'));
    return response.data;
  };
  async function session(page, expected) {
    assert.equal(new URL(page.url()).origin, ORIGIN, 'Use only the isolated owning browser.');
    const current = checked(await matrixSmokeRequest(() => api(page, '/api/auth/session')), 'Read owning CI session');
    assert.equal(current.userId, expected.userId); assert.equal(current.deviceId, expected.deviceId); assert.equal(current.admin, false);
  }
  const native = (page, path, body, method) => {
    assert.equal(new URL(page.url()).origin, ORIGIN);
    const request = () => api(page, '/_matrix/client/v3' + path, body, true, false, method);
    return body === undefined ? matrixSmokeRequest(request) : request();
  };
  const room = id => { assert.ok(ROOM.test(id) && fixtures.has(id)); return '/rooms/' + encodeURIComponent(id); };
  const state = (id, type, key = '') => room(id) + '/state/' + encodeURIComponent(type) + '/' + encodeURIComponent(key);
  async function create(label, space, parent) {
    await session(alice, aliceSession);
    if (parent) { room(parent); assert.equal(fixtures.get(parent).space, true); }
    const name = 'CI role mentions ' + label + ' ' + nonce;
    const initial = space ? [] : [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
      { type: 'm.space.parent', state_key: parent, content: { canonical: true, via: ['chat.example.test'] } },
    ];
    const id = checked(await matrixSmokeCreateFixture(body => native(alice, '/createRoom', body), {
      name, visibility: 'private', preset: 'private_chat',
      creation_content: { 'm.federate': false, [MARKER]: nonce, ...(space ? { type: 'm.space' } : {}) }, initial_state: initial,
    }), 'Create a fresh private CI fixture without invitation side effects').room_id;
    assert.ok(ROOM.test(id) && !fixtures.has(id)); fixtures.set(id, { name, space });
    await inspect(id, false); return id;
  }
  async function inspect(id, joined = true) {
    await session(alice, aliceSession);
    const events = checked(await native(alice, room(id) + '/state'), 'Inspect the exact fresh CI room');
    const find = type => events.find(event => event.type === type && event.state_key === '');
    const create = find('m.room.create');
    assert.equal(create.sender, ALICE); assert.equal(create.content[MARKER], nonce); assert.equal(create.content['m.federate'], false);
    assert.equal(HASH_ROOM.test(id), create.content.room_version === '12', 'The fresh native room ID must match its inspected version.');
    assert.equal(create.content.type === 'm.space', fixtures.get(id).space); assert.equal(find('m.room.name').content.name, fixtures.get(id).name);
    assert.equal(find('m.room.join_rules').content.join_rule, 'invite');
    const members = events.filter(event => event.type === 'm.room.member').map(event => [event.state_key, event.content.membership]).sort();
    assert.deepEqual(members, (joined ? [[ALICE, 'join'], [BOB, 'join']] : [[ALICE, 'join']]).sort());
    assertRoleFixtureAuthority(create, find('m.room.power_levels').content);
    if (!fixtures.get(id).space) {
      assert.equal(find('m.room.encryption').content.algorithm, 'm.megolm.v1.aes-sha2');
      assert.equal(find('m.room.history_visibility').content.history_visibility, 'joined');
    }
    return events;
  }
  await session(alice, aliceSession); await session(bob, bobSession);
  const savedPrivacy = checked(await api(bob, '/api/social/invitation-privacy'), 'Read recipient invitation preference').invitations;
  assert.ok(MODES.includes(savedPrivacy));
  let changedPrivacy = false, failure, listener;
  try {
    if (savedPrivacy !== 'everyone') {
      changedPrivacy = true;
      checked(await api(bob, '/api/social/invitation-privacy', { invitations: 'everyone' }, false, false, 'PUT'), 'Allow only this isolated fixture setup');
    }
    const server = await create('server', true), channel = await create('channel', false, server);
    await session(alice, aliceSession);
    checked(await matrixSmokeRequest(() => native(alice, state(server, 'm.space.child', channel), { via: ['chat.example.test'] }, 'PUT')), 'Publish the reciprocal native child link');
    for (const id of [server, channel]) {
      await session(alice, aliceSession); await session(bob, bobSession);
      const member = () => native(alice, state(id, 'm.room.member', BOB));
      checked(await matrixSmokeInvite(member, () => native(alice, room(id) + '/invite', { user_id: BOB })), 'Invite only Bob to the known fixture');
      checked(await matrixSmokeJoin(member, () => native(bob, '/join/' + encodeURIComponent(id), {})), 'Join only the explicitly selected fixture');
      await inspect(id);
    }
    const serverState = await inspect(server), channelState = await inspect(channel);
    assert.deepEqual(serverState.find(event => event.type === 'm.space.child' && event.state_key === channel)?.content, { via: ['chat.example.test'] });
    assert.deepEqual(channelState.find(event => event.type === 'm.space.parent' && event.state_key === server)?.content, { canonical: true, via: ['chat.example.test'] });
    const baseline = {
      version: 1, owner: ALICE,
      roles: [
        { id: 'everyone', name: 'Member', color: '', icon: '', position: 0, permissions: ['send_messages', 'add_reactions', 'invite'], mentionable: false, separate: false },
        { id: 'helpers', name: 'Helpers', color: '', icon: '', position: 10, permissions: [], mentionable: true, separate: false },
        { id: 'unused', name: 'Helpers', color: '', icon: '', position: 20, permissions: [], mentionable: true, separate: false },
      ], members: { [BOB]: ['helpers'] }, overrides: {}, categoryOverrides: {},
    };
    const readPolicy = async () => {
      const events = await inspect(server);
      return events.find(event => event.type === ROLES && event.state_key === '') || null;
    };
    async function savePolicy(transform) {
      await session(alice, aliceSession);
      const before = await readPolicy(), next = transform(structuredClone(before?.content || baseline));
      assert.equal(next.owner, ALICE); assert.deepEqual(next.members, { [BOB]: ['helpers'] });
      const content = { ...next, 'io.tavern.previous_event': before?.event_id || null };
      checked(await matrixSmokeRequest(async () => {
        const current = await readPolicy();
        // Only a confirmed native write may reconcile a retry after 429.
        // A network error or a different native revision is not replayed.
        if (current && isDeepStrictEqual(current.content, content)) return { status: 200, data: { event_id: current.event_id } };
        assert.equal(current?.event_id, before?.event_id); assert.deepEqual(current?.content, before?.content);
        return native(alice, state(server, ROLES), content, 'PUT');
      }), 'Save current native owner-authorized role policy');
      const after = await readPolicy(); assert.ok(after.event_id.startsWith('$')); assert.deepEqual(after.content, content); return after;
    }
    const initial = await savePolicy(value => value);
    await session(bob, bobSession);
    const denied = await native(bob, state(server, ROLES), { ...initial.content, 'io.tavern.previous_event': initial.event_id, roles: initial.content.roles.map(role => ({ ...role, mentionable: true })) }, 'PUT');
    assert.equal(denied.status, 403); assert.equal(denied.data.errcode, 'M_FORBIDDEN');
    assert.equal((await readPolicy()).event_id, initial.event_id, 'A lower native member cannot configure server role mentions.');
    const composer = page => page.locator('.conversation-main .composer textarea');
    const menuItem = (name, id = 'helpers') => alice.getByRole('menuitem', { name: 'Mention role ' + name + ' (' + id + ') in ' + fixtures.get(server).name, exact: true });
    async function open(page, expected) {
      await page.goto(ORIGIN + '/#room=' + encodeURIComponent(channel)); await ready(page); await session(page, expected);
      await expect(page.getByRole('dialog')).toHaveCount(0); await expect(composer(page)).toHaveCount(1); await expect(composer(page)).toBeEnabled();
    }
    async function picker(name, select = false) {
      await alice.getByRole('button', { name: 'Mention a member', exact: true }).click();
      await expect(menuItem(name)).toBeVisible();
      if (select) await menuItem(name).click(); else await alice.keyboard.press('Escape');
    }
    async function sendCurrent(expectedMentions) {
      await session(alice, aliceSession); await session(bob, bobSession);
      const body = await composer(alice).inputValue(); assert.ok(body && body.length < 8000);
      const response = await encryptedResponse(alice, () => alice.getByRole('button', { name: 'Send message', exact: true }).click());
      assert.ok(decodeURIComponent(new URL(response.url()).pathname).includes('/rooms/' + channel + '/send/m.room.encrypted/'));
      const eventId = await encryptedEvent(alice, channel, response, body);
      assert.ok(typeof eventId === 'string' && eventId.startsWith('$')); assert.ok(!proofs.some(proof => proof.eventId === eventId));
      await expect(composer(alice)).toHaveValue('');
      for (const page of [alice, bob]) await expect(page.locator('article.message[id=' + JSON.stringify('message-' + eventId) + '] .message-body')).toBeVisible({ timeout: 60000 });
      proofs.push({ eventId, body, mentions: expectedMentions }); return eventId;
    }
    await open(alice, aliceSession); await open(bob, bobSession);
    await picker('Helpers', true);
    const token = '[@Helpers](tavern-role:' + encode(server) + '/helpers)';
    await expect(composer(alice)).toHaveValue(token + ' ');
    await sendCurrent({ user_ids: [BOB] });

    await picker('Helpers', true); await expect(composer(alice)).toHaveValue(token + ' ');
    await savePolicy(value => ({ ...value, roles: value.roles.map(role => role.id === 'helpers' ? { ...role, name: 'Renamed helpers' } : role) }));
    // Wait for the actual SDK-fed picker, while preserving the original draft.
    await picker('Renamed helpers'); await expect(composer(alice)).toHaveValue(token + ' ');
    await sendCurrent({ user_ids: [BOB] });

    const example = '`[@everyone](tavern-role:' + encode(server) + '/helpers)`';
    await composer(alice).fill(example); await sendCurrent({ user_ids: [] });

    await picker('Renamed helpers', true); const retained = await composer(alice).inputValue();
    await savePolicy(value => ({ ...value, roles: value.roles.map(role => role.id === 'helpers' ? { ...role, mentionable: false } : role) }));
    await alice.getByRole('button', { name: 'Mention a member', exact: true }).click();
    await expect(menuItem('Renamed helpers')).toHaveCount(0); await expect(menuItem('Helpers', 'unused')).toBeVisible(); await alice.keyboard.press('Escape');
    const messages = async () => checked(await native(alice, room(channel) + '/messages?dir=b&limit=100'), 'Read only native fixture event IDs').chunk
      .filter(event => ['m.room.encrypted', 'm.room.message'].includes(event.type)).map(event => event.event_id).sort();
    const before = await messages(), sends = [];
    listener = request => {
      const url = new URL(request.url());
      if (url.origin === ORIGIN && request.method() === 'PUT' && decodeURIComponent(url.pathname).includes('/rooms/' + channel + '/send/')) sends.push(url.pathname);
    };
    alice.on('request', listener);
    await session(alice, aliceSession); await alice.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(alice.getByText('A selected role is no longer mentionable in this conversation. Remove it or choose a current role.', { exact: true })).toBeVisible();
    await expect(alice.getByText('Message was not confirmed. Your draft is kept.', { exact: true })).toBeVisible();
    await expect(composer(alice)).toHaveValue(retained); await expect(alice.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    assert.deepEqual(await messages(), before); assert.deepEqual(sends, []);
    alice.off('request', listener); listener = undefined;

    for (const [page, expected] of [[alice, aliceSession], [bob, bobSession]]) {
      await session(page, expected);
      await page.getByRole('button', { name: 'Tavern settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Privacy', exact: true }).click();
      // Choose the shipped download path; no SDK or cryptographic code changes.
      await page.evaluate(() => { delete window.showSaveFilePicker; if ('showSaveFilePicker' in window) throw new Error('The CI download fallback is unavailable.'); });
      const section = page.locator('section.settings-section').filter({ has: page.getByRole('heading', { name: 'Export message history', exact: true }) });
      await section.getByLabel('Conversations', { exact: true }).selectOption(channel);
      await section.getByLabel('Only messages I sent', { exact: true }).uncheck();
      await section.getByLabel('I understand the downloaded file contains unencrypted message content and must be kept private.', { exact: true }).check();
      const [download] = await Promise.all([page.waitForEvent('download'), section.getByRole('button', { name: 'Download history', exact: true }).click()]);
      const stream = await download.createReadStream(); assert.ok(stream); const chunks = []; let bytes = 0;
      try {
        for await (const chunk of stream) { bytes += chunk.length; assert.ok(bytes <= 1048576, 'Only this bounded fresh room may be exported.'); chunks.push(chunk); }
      } finally { stream.destroy(); }
      const rows = Buffer.concat(chunks).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(rows[0].type, 'manifest'); assert.equal(rows[0].userId, expected.userId); assert.equal(rows.at(-1).type, 'complete');
      assert.equal(rows.at(-1).roomsDone, 1); assert.equal(rows.at(-1).undecryptable, 0);
      assert.deepEqual(rows.filter(row => row.type === 'room').map(row => row.roomId), [channel]);
      const events = rows.filter(row => row.type === 'event');
      assert.deepEqual(events.map(event => event.eventId).sort(), proofs.map(proof => proof.eventId).sort());
      for (const proof of proofs) {
        const event = events.find(row => row.eventId === proof.eventId);
        assert.equal(event.roomId, channel); assert.equal(event.sender, ALICE); assert.equal(event.eventType, 'm.room.message');
        assert.equal(event.content.msgtype, 'm.text'); assert.equal(event.content.body, proof.body); assert.deepEqual(event.content['m.mentions'], proof.mentions);
      }
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click(); await session(page, expected);
    }
    console.log('PASS: real encrypted role mentions target Bob through stable role IDs after a rename; both owning SDK exports confirm exact native m.mentions and code examples without room-wide alerts.');
    console.log('PASS: native lower-member role edits are rejected; making the selected role unmentionable keeps the composer draft and sends no Matrix event.');
  } catch (error) { failure = error; }
  finally {
    if (listener) alice.off('request', listener);
    if (changedPrivacy) try {
      await session(bob, bobSession);
      checked(await api(bob, '/api/social/invitation-privacy', { invitations: savedPrivacy }, false, false, 'PUT'), 'Restore recipient original invitation preference');
    } catch { failure ||= new Error('Could not restore the isolated role-probe recipient invitation preference.'); }
  }
  if (failure) throw failure;
}
