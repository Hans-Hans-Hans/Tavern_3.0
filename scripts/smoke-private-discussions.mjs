// Native enforcement and real SDK encryption on the isolated live CI stack.
import { expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { matrixSmokeRequest } from './matrix-smoke-request.mjs';

// Only these negative probes retry: remove invitations from the otherwise
// identical private configuration. Pinned Synapse applies creation rate limits
// before the private-source authorization callback or any room persistence.
// https://github.com/element-hq/synapse/blob/v1.160.0/synapse/handlers/room.py#L1008-L1037
// Keep successful creation with invite side effects on its non-retryable path.
export async function privateCreationDenialProbe(create, configuration, description, pause) {
  const probe = structuredClone(configuration);
  const fields = new Set(['visibility', 'preset', 'invite', 'creation_content', 'initial_state']);
  const states = new Set(['io.tavern.private_thread.settings', 'm.room.encryption', 'm.room.history_visibility']);
  assert.ok(probe && Object.keys(probe).every(key => fields.has(key)) && probe.visibility === 'private'
    && probe.preset === 'private_chat' && probe.creation_content?.type === 'io.tavern.private_thread'
    && probe.creation_content['m.federate'] === false && Array.isArray(probe.initial_state)
    && probe.initial_state.every(event => states.has(event?.type) && event.state_key === ''), 'Use only the isolated private discussion denial fixture.');
  delete probe.invite;
  const result = await matrixSmokeRequest(() => create(structuredClone(probe)), pause);
  assert.equal(result.status, 403, description + ': ' + JSON.stringify(result.data));
  assert.equal(result.data?.errcode, 'M_FORBIDDEN', description);
  return result;
}

export async function privateDiscussionSmoke({ admin, alice, bob, adminSession, aliceSession, bobSession, origin, api, encryptedResponse, encryptedEvent }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true') throw new Error('Private discussion smoke requires the isolated CI stack.');
  const privateType = 'io.tavern.private_thread', settingsType = privateType + '.settings';
  const rolesType = 'io.tavern.roles', title = 'CI invited private discussion';
  const native = (page, path, body, method) => {
    const request = () => api(page, '/_matrix/client/v3' + path, body, true, false, method);
    return body === undefined || method === 'PUT' ? matrixSmokeRequest(request) : request();
  };
  const roomPath = roomId => '/rooms/' + encodeURIComponent(roomId);
  const statePath = (roomId, type, key = '') => roomPath(roomId) + '/state/' + encodeURIComponent(type) + '/' + encodeURIComponent(key);
  function ok(result, description) { assert.equal(result.status, 200, description + ': ' + JSON.stringify(result.data)); return result.data; }
  function forbidden(result, description) { assert.equal(result.status, 403, description + ': ' + JSON.stringify(result.data)); }
  function unreadable(result, description) {
    assert.ok([403, 404].includes(result.status), description + ': ' + JSON.stringify(result.data));
    assert.ok(!JSON.stringify(result.data).includes(title), 'Denied reads must not disclose the private title.');
  }
  const policy = {
    version: 1, owner: adminSession.userId,
    roles: [
      { id: 'everyone', name: 'Member', color: '', icon: '', position: 0, permissions: ['send_messages', 'add_reactions', 'invite'], mentionable: false, separate: false },
      { id: 'private_creator', name: 'Discussion creator', color: '', icon: '', position: 10, permissions: ['create_private_threads'], mentionable: false, separate: false },
    ], members: {}, overrides: {}, categoryOverrides: {},
  };
  const invite = [aliceSession.userId, bobSession.userId];
  const serverId = ok(await native(admin, '/createRoom', {
    name: 'CI private discussion server', visibility: 'private', preset: 'private_chat', invite,
    creation_content: { type: 'm.space', 'm.federate': false },
    initial_state: [{ type: rolesType, state_key: '', content: policy }],
  }), 'Create the separately governed source server').room_id;
  const sourceId = ok(await native(admin, '/createRoom', {
    name: 'CI private discussion source', visibility: 'private', preset: 'private_chat', invite,
    creation_content: { 'm.federate': false },
    initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: 'm.space.parent', state_key: serverId, content: { canonical: true, via: ['chat.example.test'] } },
    ],
  }), 'Create the encrypted source channel').room_id;
  ok(await native(admin, statePath(serverId, 'm.space.child', sourceId), { via: ['chat.example.test'] }, 'PUT'), 'Link source to its actual owner server');
  for (const participant of [alice, bob]) for (const roomId of [serverId, sourceId]) {
    ok(await native(participant, '/join/' + encodeURIComponent(roomId), {}), 'Join every source scope');
  }
  const creation = {
    visibility: 'private', preset: 'private_chat', invite: [bobSession.userId],
    creation_content: { type: privateType, 'm.federate': false, [privateType]: { version: 1, source_room_id: sourceId, source_event_id: '' } },
    initial_state: [
      { type: settingsType, state_key: '', content: { version: 1, title, archived: false, autoArchiveSeconds: 0, 'io.tavern.previous_event': null } },
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ],
  };
  await privateCreationDenialProbe(body => native(alice, '/createRoom', body), creation, 'Ordinary source membership must not grant private creation');
  async function writePolicy(next) {
    const state = ok(await native(admin, roomPath(serverId) + '/state'), 'Read current source policy revision');
    const current = state.find(event => event.type === rolesType && event.state_key === '');
    assert.ok(current?.event_id);
    ok(await native(admin, statePath(serverId, rolesType), { ...next, 'io.tavern.previous_event': current.event_id }, 'PUT'), 'Write explicit source permissions');
  }
  policy.members[aliceSession.userId] = ['private_creator'];
  await writePolicy(policy);
  const privateId = ok(await native(alice, '/createRoom', creation), 'Explicitly delegated ordinary account creates private discussion').room_id;
  const privateState = ok(await native(alice, roomPath(privateId) + '/state'), 'Read actual private room state');
  const content = type => privateState.find(event => event.type === type && event.state_key === '')?.content;
  assert.equal(content('m.room.create').type, privateType);
  assert.equal(content('m.room.create')['m.federate'], false);
  assert.deepEqual(content('m.room.create')[privateType], { version: 1, source_room_id: sourceId, source_event_id: '' });
  assert.equal(content('m.room.encryption').algorithm, 'm.megolm.v1.aes-sha2');
  assert.equal(content('m.room.history_visibility').history_visibility, 'joined');
  assert.equal(content('m.room.join_rules').join_rule, 'invite');
  assert.equal(content('m.room.guest_access').guest_access, 'forbidden');
  assert.equal(content('m.room.power_levels').users_default, 0);
  assert.deepEqual(privateState.filter(event => event.type === 'm.room.member').map(event => [event.state_key, event.content.membership]).sort(), [[aliceSession.userId, 'join'], [bobSession.userId, 'invite']].sort());
  assert.ok(!privateState.some(event => event.type === 'm.space.parent'));
  for (const scope of [serverId, sourceId]) {
    const state = ok(await native(admin, roomPath(scope) + '/state'), 'Inspect only public source metadata');
    assert.ok(!JSON.stringify(state).includes(privateId), 'Source state must not publish an index of private discussions.');
  }
  forbidden(await native(admin, '/join/' + encodeURIComponent(privateId), {}), 'Even the source owner needs a private invitation');
  unreadable(await native(admin, roomPath(privateId) + '/state'), 'The source owner cannot read private state');
  unreadable(await native(admin, roomPath(privateId) + '/messages?dir=b&limit=10'), 'The source owner cannot read private history');
  for (const [type, value, key] of [
    ['m.room.history_visibility', { history_visibility: 'world_readable' }],
    ['m.room.join_rules', { join_rule: 'public' }],
    ['m.room.guest_access', { guest_access: 'can_join' }],
    ['m.room.power_levels', { users_default: 100 }],
    ['m.space.parent', { canonical: true, via: ['chat.example.test'] }, serverId],
  ]) forbidden(await native(alice, statePath(privateId, type, key), value, 'PUT'), 'The creator cannot widen private access: ' + type);
  forbidden(await native(alice, '/directory/list/room/' + encodeURIComponent(privateId), { visibility: 'public' }, 'PUT'), 'The creator cannot publish the private room directory entry');
  forbidden(await native(admin, statePath(serverId, 'm.space.child', privateId), { via: ['chat.example.test'] }, 'PUT'), 'The source owner cannot publish a child link to the private room');
  const sendNative = (page, type, payload) => native(page, roomPath(privateId) + '/send/' + type + '/' + randomBytes(12).toString('hex'), payload, 'PUT');
  forbidden(await sendNative(alice, 'm.room.message', { msgtype: 'm.text', body: 'Unencrypted private messages must be rejected.' }), 'Private discussion plaintext sends must be rejected');
  console.log('PASS: native private discussion creation requires explicit source permission; only Alice and invited Bob are members; source owner reads/joins and privacy widening are rejected.');

  async function openPrivate(page) {
    await page.goto(origin + '/#room=' + encodeURIComponent(privateId));
    // The sheet correctly aria-hides the workspace; ready() queries its home
    // button and therefore is intentionally not used while this modal is open.
    await expect(page.locator('.connection')).toContainText('Connected', { timeout: 60000 });
    const panel = page.getByRole('complementary', { name: 'Private discussion', exact: true });
    await expect(panel).toBeVisible({ timeout: 60000 }); return panel;
  }
  const alicePanel = await openPrivate(alice);
  let bobPanel = await openPrivate(bob);
  await bobPanel.getByRole('button', { name: 'Accept private discussion', exact: true }).click();
  await expect(bobPanel.getByRole('textbox', { name: 'Message ' + title, exact: true })).toBeEnabled({ timeout: 60000 });
  async function send(page, panel, text) {
    await panel.getByRole('textbox', { name: 'Message ' + title, exact: true }).fill(text);
    const response = await encryptedResponse(page, () => panel.getByRole('button', { name: 'Send message', exact: true }).click());
    return encryptedEvent(page, privateId, response, text);
  }
  const text = 'Private Alice proof ' + randomBytes(12).toString('hex');
  const eventId = await send(alice, alicePanel, text);
  await expect(bobPanel.locator('.message-body').filter({ hasText: text })).toBeVisible({ timeout: 60000 });
  const reply = 'Private Bob proof ' + randomBytes(12).toString('hex');
  const replyId = await send(bob, bobPanel, reply);
  await expect(alicePanel.locator('.message-body').filter({ hasText: reply })).toBeVisible({ timeout: 60000 });
  unreadable(await native(admin, roomPath(privateId) + '/event/' + encodeURIComponent(eventId)), 'The source owner cannot read the known encrypted event');
  const ownerRooms = ok(await native(admin, '/joined_rooms'), 'Read source owner native memberships').joined_rooms;
  assert.ok(!ownerRooms.includes(privateId));
  bobPanel = await openPrivate(bob);
  assert.equal((await api(bob, '/api/auth/session')).data.deviceId, bobSession.deviceId);
  await expect(bobPanel.locator('.message-body').filter({ hasText: text })).toBeVisible({ timeout: 60000 });
  await expect(bobPanel.locator('.message-body').filter({ hasText: reply })).toBeVisible({ timeout: 60000 });
  console.log('PASS: Bob accepts the private invitation; Alice and Bob exchange actual encrypted messages and retain same-device decryption after reload while the source owner remains excluded.');

  // Reuse real opaque content only in requests that must be denied. This
  // exercises server policy independently of disabled buttons or SDK caches.
  const aliceCiphertext = ok(await native(alice, roomPath(privateId) + '/event/' + encodeURIComponent(eventId)), 'Read Alice ciphertext as an actual private member').content;
  const bobCiphertext = ok(await native(bob, roomPath(privateId) + '/event/' + encodeURIComponent(replyId)), 'Read Bob ciphertext as an actual private member').content;
  const deniedPolicy = { ...policy, overrides: { [sourceId]: { roles: {}, users: { [aliceSession.userId]: { send_messages: -1 } } } } };
  await writePolicy(deniedPolicy);
  forbidden(await sendNative(alice, 'm.room.encrypted', aliceCiphertext), 'Source channel custom deny applies to opaque private sends');
  await privateCreationDenialProbe(body => native(alice, '/createRoom', body), creation, 'Source channel custom deny also prevents another private discussion');
  await writePolicy(policy);
  ok(await native(bob, roomPath(sourceId) + '/leave', {}), 'Bob leaves the source channel');
  forbidden(await sendNative(bob, 'm.room.encrypted', bobCiphertext), 'Source membership loss stops opaque private sends');
  assert.equal(ok(await native(alice, statePath(privateId, 'm.room.member', bobSession.userId)), 'Read retained private membership').membership, 'join');
  const settings = ok(await native(alice, roomPath(privateId) + '/state'), 'Read current private settings revision').find(event => event.type === settingsType && event.state_key === '');
  assert.ok(settings?.event_id);
  const archived = { ...settings.content, archived: true, 'io.tavern.previous_event': settings.event_id };
  ok(await native(alice, statePath(privateId, settingsType), archived, 'PUT'), 'Archive using the current settings revision');
  forbidden(await sendNative(alice, 'm.room.encrypted', aliceCiphertext), 'Archived private discussions reject opaque encrypted sends');
  forbidden(await native(alice, statePath(privateId, settingsType), { ...archived, archived: false }, 'PUT'), 'A stale revision cannot reopen the discussion');
  await expect(alicePanel.getByText('This discussion is archived.', { exact: false })).toBeVisible();
  await expect(alicePanel.getByRole('textbox', { name: 'Message ' + title, exact: true })).toBeDisabled();
  console.log('PASS: live source permission changes, source membership loss, archive state, and stale settings revisions are enforced on direct encrypted Matrix sends without erasing existing private membership.');
}
