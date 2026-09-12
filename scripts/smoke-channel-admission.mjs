// Actual native private-channel authorization on fresh, explicitly marked CI rooms.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { isCiRoomId, assertCiRoomCreation } from './ci-room-id.mjs';
import { matrixSmokeRequest, matrixSmokeJoin, matrixSmokeInvite, matrixSmokeCreateFixture } from './matrix-smoke-request.mjs';

const ORIGIN = 'https://chat.example.test', ALICE = '@cialice:chat.example.test', BOB = '@cibob:chat.example.test';
const POLICY = 'io.tavern.roles', MARKER = 'io.tavern.ci_channel_admission';
export async function channelAdmissionSmoke({ alice, bob, aliceSession, bobSession, origin, api }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls' || origin !== ORIGIN
      || aliceSession?.userId !== ALICE || bobSession?.userId !== BOB || aliceSession.admin !== false || bobSession.admin !== false
      || !aliceSession.deviceId || !bobSession.deviceId || alice.context() === bob.context()) throw new Error('Channel admission requires the exact isolated CI accounts and stack.');
  const owners = new Map([[alice, aliceSession], [bob, bobSession]]), fixtures = new Map(), runId = randomBytes(12).toString('hex');
  const checked = (result, label, status = 200) => { assert.equal(result.status, status, label); return result.data; };
  async function session(page) {
    assert.ok(owners.has(page)); assert.equal(new URL(page.url()).origin, ORIGIN);
    const actual = checked(await api(page, '/api/auth/session'), 'Read exact owning session'), owner = owners.get(page);
    assert.equal(actual.userId, owner.userId); assert.equal(actual.deviceId, owner.deviceId); assert.equal(actual.admin, false);
  }
  const native = (page, path, body, method) => {
    assert.ok(owners.has(page)); assert.equal(new URL(page.url()).origin, ORIGIN);
    const request = () => api(page, '/_matrix/client/v3' + path, body, true, false, method);
    return body === undefined || method === 'PUT' ? matrixSmokeRequest(request) : request();
  };
  const room = id => { assert.ok(fixtures.has(id) && isCiRoomId(id)); return '/rooms/' + encodeURIComponent(id); };
  const state = (id, type, key = '') => room(id) + '/state/' + encodeURIComponent(type) + '/' + encodeURIComponent(key);
  async function inspect(id) {
    await session(alice);
    const events = checked(await native(alice, room(id) + '/state'), 'Read bounded current CI room');
    const find = assertCiRoomCreation({ id, events, creator: ALICE, marker: MARKER, runId, ...fixtures.get(id) });
    assert.ok(events.filter(event => event.type === 'm.room.member').every(event => [ALICE, BOB].includes(event.state_key)));
    if (!fixtures.get(id).space) assert.equal(find('m.room.encryption').content.algorithm, 'm.megolm.v1.aes-sha2');
    return { events, find };
  }
  async function create(label, space, parent) {
    await session(alice); if (parent) await inspect(parent);
    const name = 'CI private channel ' + label + ' ' + runId;
    const initial = space ? [] : [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } }];
    if (parent) initial.push({ type: 'm.space.parent', state_key: parent, content: { canonical: true, via: ['chat.example.test'] } });
    const id = checked(await matrixSmokeCreateFixture(config => native(alice, '/createRoom', config), {
      name, preset: 'private_chat', visibility: 'private', creation_content: { 'm.federate': false, [MARKER]: runId, ...(space ? { type: 'm.space' } : {}) }, initial_state: initial,
    }), 'Create a fresh marked private fixture').room_id;
    assert.ok(isCiRoomId(id) && !fixtures.has(id)); fixtures.set(id, { name, space }); await inspect(id); return id;
  }
  async function put(id, type, body, key = '') { await inspect(id); return native(alice, state(id, type, key), body, 'PUT'); }
  const member = (id, user = BOB) => { assert.ok([ALICE, BOB].includes(user)); return native(alice, state(id, 'm.room.member', user)); };
  const join = async id => { await session(bob); await inspect(id); return matrixSmokeJoin(() => member(id), () => native(bob, '/join/' + encodeURIComponent(id), {})); };
  for (const page of owners.keys()) await session(page);
  const until = Date.now() + 30000;
  for (;;) {
    const ready = checked(await api(alice, '/api/channels/admission/capability'), 'Read running native admission capability');
    if (ready.version === 1 && ready.available === true) break;
    assert.ok(Date.now() < until, 'Native worker must initialize its real database before private channels are writable.'); await pause(500);
  }
  const server = await create('server', true), channel = await create('voice', false, server);
  checked(await put(server, 'm.space.child', { via: ['chat.example.test'] }, channel), 'Link the actual governed channel');
  let policy = { version: 1, owner: ALICE, roles: [
    { id: 'everyone', name: 'Member', color: '', icon: '', position: 0, permissions: ['send_messages', 'join_calls'], mentionable: false, separate: false },
    { id: 'gaming', name: 'Gaming', color: '#4466aa', icon: '', position: 1, permissions: [], mentionable: false, separate: false },
  ], members: {}, overrides: {}, categoryOverrides: {} };
  checked(await put(server, POLICY, policy), 'Initialize ordinary server roles');
  const powers = (await inspect(channel)).find('m.room.power_levels').content;
  checked(await put(channel, 'm.room.power_levels', { ...powers, events: { ...powers.events, 'org.matrix.msc3401.call.member': 0 } }), 'Enable native call membership for ordinary members');
  checked(await put(channel, 'io.tavern.channel', { version: 1, kind: 'voice', archived: false, slowModeSeconds: 0 }), 'Set the actual voice channel kind');
  checked(await matrixSmokeInvite(() => member(server), () => native(alice, room(server) + '/invite', { user_id: BOB })), 'Invite Bob only to the server');
  checked(await join(server), 'Join Bob to the server');
  async function change(next) {
    const saved = (await inspect(server)).find(POLICY); assert.ok(saved.event_id);
    const desired = { ...next, 'io.tavern.previous_event': saved.event_id };
    checked(await put(server, POLICY, desired), 'Save audience against current native role revision'); policy = desired;
  }
  await change({ ...policy, channelAdmissionVersion: 1, channelAdmissions: { [channel]: { roleIds: ['gaming'], userIds: [] } } });
  checked(await put(channel, 'm.room.join_rules', { join_rule: 'restricted', allow: [{ type: 'm.room_membership', room_id: server }] }), 'Open only native restricted joins after audience enforcement');
  checked(await member(channel), 'Bob has never been invited to this channel', 404);
  checked(await join(channel), 'A server member without the selected role cannot self-join', 403);
  checked(await native(alice, room(channel) + '/invite', { user_id: BOB }), 'An owner cannot bypass the selected audience by inviting', 403);
  async function catalog() { await session(bob); return checked(await api(bob, '/api/servers/' + encodeURIComponent(server) + '/channels/available'), 'Read native audience-filtered discovery'); }
  assert.deepEqual((await catalog()).channels, []);
  await change({ ...policy, members: { [BOB]: ['gaming'] } });
  assert.deepEqual((await catalog()).channels.map(item => item.id), [channel]);
  checked(await join(channel), 'An eligible member can explicitly join without an invitation');
  assert.equal(checked(await member(channel), 'Read real accepted channel membership').membership, 'join');
  checked(await put(channel, 'm.room.join_rules', { join_rule: 'public' }), 'Active private audience cannot be made public', 403);
  checked(await put(channel, 'm.space.parent', {}, server), 'Active private audience cannot be detached', 403);
  console.log('PASS: real Synapse private-channel capability is ready; selected roles govern discovery, invitations and uninvited restricted joins; native public/detach bypasses are denied.');
  async function token(status) {
    await session(bob); await inspect(channel);
    const openid = checked(await native(bob, '/user/' + encodeURIComponent(BOB) + '/openid/request_token', {}), 'Obtain the owning device native OpenID proof');
    const result = await api(bob, '/livekit/jwt/sfu/get', { room: channel, device_id: bobSession.deviceId, openid_token: openid });
    checked(result, 'Real SFU admission must follow private channel authority', status);
    if (status === 200) assert.ok(typeof result.data.jwt === 'string' && result.data.url === 'wss://chat.example.test/livekit/sfu');
    else assert.ok(!result.data.jwt);
  }
  await token(200);
  await change({ ...policy, members: {} });
  await token(403);
  checked(await native(bob, room(channel) + '/send/m.room.encrypted/' + randomBytes(12).toString('hex'), { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'ci-denied-probe' }, 'PUT'), 'Revoked member cannot send new encrypted events', 403);
  const removedBy = Date.now() + 45000;
  while (checked(await member(channel), 'Observe actual membership revocation').membership !== 'leave') {
    assert.ok(Date.now() < removedBy, 'Durable native worker must remove the actual channel membership.'); await pause(500);
  }
  assert.deepEqual((await catalog()).channels, []);
  checked(await join(channel), 'Revoked member cannot rejoin', 403);
  await change({ ...policy, members: { [BOB]: ['gaming'] } });
  checked(await join(channel), 'Regrant permits an explicit native rejoin');
  await pause(3500);
  assert.equal(checked(await member(channel), 'A later worker pass must retain the regranted member').membership, 'join');
  await token(200);
  console.log('PASS: real LiveKit token issuance follows selected channel roles; revocation denies sends and RTC, the native durable worker removes membership, and regrant permits a stable explicit rejoin.');
}
