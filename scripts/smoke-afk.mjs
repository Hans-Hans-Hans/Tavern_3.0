// Native AFK configuration acceptance only; this never starts a call or capture.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isCiRoomId, assertCiRoomCreation } from './ci-room-id.mjs';
import { matrixSmokeJoin, matrixSmokeRequest } from './matrix-smoke-request.mjs';

export async function afkSmoke({ admin, alice, adminSession, aliceSession, api }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls'
    || adminSession?.userId !== '@ciadmin:chat.example.test' || adminSession.admin !== true || !adminSession.deviceId
    || aliceSession?.userId !== '@cialice:chat.example.test' || aliceSession.admin !== false || !aliceSession.deviceId
    || [admin, alice].some(page => new URL(page.url()).origin !== 'https://chat.example.test')) throw new Error('AFK smoke requires the isolated CI stack.');
  const runId = randomBytes(12).toString('hex'), fixtures = new Set();
  const afk = 'io.tavern.server.afk', channel = 'io.tavern.channel';
  const native = (page, path, body, method) => {
    assert.equal(new URL(page.url()).origin, 'https://chat.example.test');
    const request = () => api(page, '/_matrix/client/v3' + path, body, true, false, method);
    return body === undefined || method === 'PUT' ? matrixSmokeRequest(request) : request();
  };
  const room = id => { assert.ok(isCiRoomId(id) && fixtures.has(id)); return '/rooms/' + encodeURIComponent(id); };
  const state = (id, type, key = '') => room(id) + '/state/' + encodeURIComponent(type) + '/' + encodeURIComponent(key);
  const checked = (response, status, description) => { assert.equal(response.status, status, description + ': ' + JSON.stringify(response.data)); return response.data; };
  async function guard(id, name, space) {
    assert.ok(isCiRoomId(id) && !fixtures.has(id)); fixtures.add(id);
    const events = checked(await native(admin, room(id) + '/state'), 200, 'Prove the fresh native AFK fixture');
    assertCiRoomCreation({ id, events, creator: adminSession.userId, name, space, marker: 'io.tavern.ci_afk', runId });
  }
  for (const [page, expected] of [[admin, adminSession], [alice, aliceSession]]) {
    const current = checked(await matrixSmokeRequest(() => api(page, '/api/auth/session')), 200, 'Inspect the owning AFK session');
    assert.equal(current.userId, expected.userId); assert.equal(current.deviceId, expected.deviceId); assert.equal(current.admin, expected.admin);
  }
  const policy = { version: 1, owner: adminSession.userId, roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages', 'join_calls'] }], members: {}, overrides: {}, categoryOverrides: {} };
  const server = checked(await native(admin, '/createRoom', {
    name: 'CI AFK settings server', room_version: '11', visibility: 'private', preset: 'private_chat', invite: [aliceSession.userId],
    creation_content: { type: 'm.space', 'm.federate': false, 'io.tavern.ci_afk': runId },
    // Give Alice native state power, but no custom manage_server permission.
    // A 403 below therefore proves Tavern's role policy adds real enforcement.
    power_level_content_override: { users: { [adminSession.userId]: 100, [aliceSession.userId]: 100 } },
    initial_state: [{ type: 'io.tavern.roles', state_key: '', content: policy }],
  }), 200, 'Create isolated AFK server').room_id;
  await guard(server, 'CI AFK settings server', true);
  const voice = checked(await native(admin, '/createRoom', {
    name: 'CI AFK voice destination', visibility: 'private', preset: 'private_chat', invite: [aliceSession.userId],
    creation_content: { 'm.federate': false, 'io.tavern.ci_afk': runId },
    initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: channel, state_key: '', content: { version: 1, kind: 'voice', archived: false, slowModeSeconds: 0 } },
      { type: 'm.space.parent', state_key: server, content: { canonical: true, via: ['chat.example.test'] } },
    ],
  }), 200, 'Create encrypted AFK voice destination').room_id;
  await guard(voice, 'CI AFK voice destination', false);
  checked(await native(admin, state(server, 'm.space.child', voice), { via: ['chat.example.test'] }, 'PUT'), 200, 'Link the AFK destination to its actual server');
  for (const id of [server, voice]) checked(await matrixSmokeJoin(
    () => native(alice, state(id, 'm.room.member', aliceSession.userId)),
    () => native(alice, '/join/' + encodeURIComponent(id), {})), 200, 'Alice joins AFK fixture scopes');
  const initial = { version: 1, channelId: voice, timeoutSeconds: 300, 'io.tavern.previous_event': null };
  const saved = checked(await native(admin, state(server, afk), initial, 'PUT'), 200, 'Save valid AFK configuration');
  assert.ok(saved.event_id);
  const stored = checked(await native(alice, state(server, afk)), 200, 'Read saved AFK settings as a server member');
  assert.deepEqual(stored, initial);
  const current = { ...initial, 'io.tavern.previous_event': saved.event_id };
  checked(await native(alice, state(server, afk), { ...current, timeoutSeconds: 600 }, 'PUT'), 403, 'Native power alone cannot edit AFK without manage_server');
  checked(await native(admin, state(server, afk), { ...initial, timeoutSeconds: 600 }, 'PUT'), 403, 'Stale AFK settings revision is rejected');
  checked(await native(admin, state(voice, channel), { version: 1, kind: 'text', archived: false, slowModeSeconds: 0 }, 'PUT'), 200, 'Change the fixture destination to a text channel');
  checked(await native(admin, state(server, afk), current, 'PUT'), 403, 'AFK cannot point at a destination that stopped being a voice channel');
  checked(await native(admin, room(server) + '/redact/' + encodeURIComponent(saved.event_id) + '/' + randomBytes(12).toString('hex'), { reason: 'CI protected configuration probe' }, 'PUT'), 403, 'AFK configuration is protected from redaction');
  const disabled = { ...current, channelId: '' };
  checked(await native(admin, state(server, afk), disabled, 'PUT'), 200, 'Disable AFK even if the previous destination is no longer valid');
  assert.deepEqual(checked(await native(alice, state(server, afk)), 200, 'Read disabled AFK configuration'), disabled);
  console.log('PASS: actual Synapse AFK configuration persists, enforces custom authority beyond native power, rejects stale state and invalid destinations, protects redaction, and can be disabled without starting media.');
  return { server, voice, runId };
}
