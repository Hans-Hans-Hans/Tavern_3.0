// Native Synapse acceptance for the stable-room reserved-state-key repair.
// No calls flag, captures, admin membership bypass, or legacy-state injection.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertCiRoomCreation, isCiRoomId } from './ci-room-id.mjs';
import { matrixSmokeCreateFixture, matrixSmokeInvite, matrixSmokeJoin, matrixSmokeLeave, matrixSmokeRequest } from './matrix-smoke-request.mjs';

const ORIGIN = 'https://chat.example.test', ADMIN = '@ciadmin:chat.example.test', ALICE = '@cialice:chat.example.test', BOB = '@cibob:chat.example.test';
const TYPES = ['io.tavern.timeout', 'io.tavern.tempban', 'io.tavern.server.nickname'], PREVIOUS = 'io.tavern.previous_event';
const MARKER = 'io.tavern.ci_audio'; // Existing isolated fixture allowlist; unique per invocation.
const key = user => { assert.ok([ADMIN, ALICE, BOB].includes(user)); return '_' + user.slice(1); };
const stableEvent = event => event && ({ event_id: event.event_id, type: event.type, state_key: event.state_key, sender: event.sender, content: event.content });

export async function memberModerationSmoke({ admin, alice, bob, adminSession, aliceSession, bobSession, origin, api }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls' || origin !== ORIGIN || typeof api !== 'function'
    || adminSession?.userId !== ADMIN || adminSession.admin !== true || !adminSession.deviceId
    || aliceSession?.userId !== ALICE || aliceSession.admin !== false || !aliceSession.deviceId
    || bobSession?.userId !== BOB || bobSession.admin !== false || !bobSession.deviceId) throw new Error('Member moderation acceptance requires the exact isolated CI stack and owning accounts.');
  const owners = new Map([[admin, adminSession], [alice, aliceSession], [bob, bobSession]]);
  assert.equal(owners.size, 3); assert.equal(new Set([...owners.keys()].map(page => page.context())).size, 3, 'Use separate owning contexts.');
  const runId = randomBytes(12).toString('hex'), rooms = new Map(), preferences = new Map();
  const checked = (result, status, description) => { assert.equal(result.status, status, description + ': ' + (result.data?.errcode || 'unexpected status')); return result.data; };
  async function session(page) {
    assert.equal(new URL(page.url()).origin, ORIGIN, 'Use only the isolated owning origin.');
    const current = checked(await matrixSmokeRequest(() => api(page, '/api/auth/session')), 200, 'Check current owning account');
    for (const field of ['userId', 'deviceId', 'admin']) assert.equal(current[field], owners.get(page)[field], 'The owning account/session changed.');
  }
  async function native(page, path, body, method) {
    assert.equal(new URL(page.url()).origin, ORIGIN);
    if (body !== undefined) await session(page);
    const request = () => api(page, '/_matrix/client/v3' + path, body, true, false, method);
    return body === undefined || method === 'PUT' ? matrixSmokeRequest(request) : request();
  }
  const roomPath = id => { assert.ok(isCiRoomId(id) && rooms.get(id)?.verified, 'Only proved fixtures from this invocation may be mutated.'); return '/rooms/' + encodeURIComponent(id); };
  const statePath = (id, type, stateKey = '') => roomPath(id) + '/state/' + encodeURIComponent(type) + '/' + encodeURIComponent(stateKey);
  async function inspect(id, initial = false) {
    assert.ok(isCiRoomId(id) && rooms.has(id)); await session(admin);
    const fixture = rooms.get(id), events = checked(await native(admin, '/rooms/' + encodeURIComponent(id) + '/state'), 200, 'Inspect native creation proof');
    const find = assertCiRoomCreation({ id, events, creator: ADMIN, name: fixture.name, space: fixture.space, marker: MARKER, runId });
    assert.equal(find('m.room.join_rules')?.content.join_rule, 'invite');
    for (const member of events.filter(item => item.type === 'm.room.member')) assert.ok([ADMIN, ALICE, BOB].includes(member.state_key));
    if (initial) {
      assert.deepEqual(events.filter(item => item.type === 'm.room.member').map(item => [item.state_key, item.content.membership]), [[ADMIN, 'join']]);
      assert.ok(!events.some(item => TYPES.includes(item.type) || item.type === 'io.tavern.roles'));
      fixture.powers = structuredClone(find('m.room.power_levels').content);
    }
    if (!fixture.space) {
      assert.equal(find('m.room.encryption')?.content.algorithm, 'm.megolm.v1.aes-sha2');
      assert.equal(find('m.room.history_visibility')?.content.history_visibility, 'joined');
    }
    fixture.verified = true; return { find, events };
  }
  async function create(space, parent) {
    await session(admin); if (parent) roomPath(parent);
    const name = 'CI member moderation ' + (space ? 'server ' : 'channel ') + runId;
    const result = checked(await matrixSmokeCreateFixture(body => native(admin, '/createRoom', body), {
      name, visibility: 'private', preset: 'private_chat', creation_content: { 'm.federate': false, [MARKER]: runId, ...(space ? { type: 'm.space' } : {}) },
      initial_state: space ? [] : [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
        { type: 'm.space.parent', state_key: parent, content: { canonical: true, via: ['chat.example.test'] } },
      ],
    }), 200, 'Create a fresh native moderation fixture');
    const id = result.room_id; assert.ok(isCiRoomId(id) && !rooms.has(id)); rooms.set(id, { name, space, verified: false });
    await inspect(id, true); return id;
  }
  async function put(id, type, body, page = admin, stateKey = '') {
    const result = checked(await native(page, statePath(id, type, stateKey), body, 'PUT'), 200, 'Write authorized native ' + type);
    assert.ok(result.event_id?.startsWith('$'));
    assert.deepEqual(checked(await native(admin, statePath(id, type, stateKey)), 200, 'Read accepted native state'), body);
    return result.event_id;
  }
  async function deny(id, type, body, stateKey = key(BOB), page = alice) {
    const before = stableEvent((await inspect(id)).find(type, stateKey));
    assert.equal(checked(await native(page, statePath(id, type, stateKey), body, 'PUT'), 403, 'Reject unauthorized native ' + type).errcode, 'M_FORBIDDEN');
    assert.deepEqual(stableEvent((await inspect(id)).find(type, stateKey)), before, 'A rejected state update cannot replace its current revision.');
  }
  async function join(id, page, user) {
    await inspect(id); await session(page);
    const membership = () => native(admin, statePath(id, 'm.room.member', user));
    checked(await matrixSmokeInvite(membership, () => native(admin, roomPath(id) + '/invite', { user_id: user })), 200, 'Invite isolated member');
    checked(await matrixSmokeJoin(membership, () => native(page, '/join/' + encodeURIComponent(id), {})), 200, 'Join isolated member');
  }
  async function leave(id, page, user) {
    await session(page);
    const membership = () => native(admin, statePath(id, 'm.room.member', user)), current = await membership();
    if (current.status === 404 && current.data?.errcode === 'M_NOT_FOUND') return;
    checked(await matrixSmokeLeave(membership, () => native(page, roomPath(id) + '/leave', {})), 200, 'Leave proved isolated fixture');
  }
  async function roles(id, grants, peer = false) {
    const previous = (await inspect(id)).find('io.tavern.roles')?.event_id ?? null;
    await put(id, 'io.tavern.roles', { version: 1, owner: ADMIN,
      roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages', 'invite'] }, { id: 'moderator', name: 'Moderator', position: 50, permissions: grants }],
      members: { [ALICE]: ['moderator'], ...(peer ? { [BOB]: ['moderator'] } : {}) }, overrides: {}, categoryOverrides: {}, [PREVIOUS]: previous });
  }
  for (const page of owners.keys()) await session(page);
  let failure;
  try {
    for (const page of [alice, bob]) {
      const saved = checked(await api(page, '/api/social/invitation-privacy'), 200, 'Read invitation preference').invitations;
      assert.ok(['everyone', 'contacts', 'shared_server', 'nobody'].includes(saved));
      if (saved !== 'everyone') { preferences.set(page, saved); await session(page); checked(await api(page, '/api/social/invitation-privacy', { invitations: 'everyone' }, false, false, 'PUT'), 200, 'Allow isolated invitations'); }
    }
    const server = await create(true), channel = await create(false, server);
    await put(server, 'm.space.child', { via: ['chat.example.test'] }, admin, channel);
    for (const id of [server, channel]) {
      await join(id, alice, ALICE); await join(id, bob, BOB);
      await put(id, 'm.room.power_levels', { ...rooms.get(id).powers, users: { ...rooms.get(id).powers.users, [ALICE]: 50, [BOB]: 0 } });
    }
    const grants = ['timeout', 'ban', 'manage_nicknames']; await roles(server, grants);
    const memberBefore = structuredClone(stableEvent((await inspect(server)).find('m.room.member', BOB)));
    for (const type of TYPES) {
      const until = Date.now() + 600000;
      const content = type === TYPES[0] ? { until } : type === TYPES[1] ? { version: 1, until } : { version: 1, name: 'Native fixture nickname' };
      const clear = type === TYPES[0] ? { until: 0 } : type === TYPES[1] ? { version: 1, until: 0 } : { version: 1, name: null };
      await deny(server, type, { ...content, [PREVIOUS]: null }, BOB); // Reserved @ key.
      await roles(server, []); await deny(server, type, { ...content, [PREVIOUS]: null });
      await roles(server, grants);
      const revision = await put(server, type, { ...content, [PREVIOUS]: null }, alice, key(BOB));
      await deny(server, type, { ...clear, [PREVIOUS]: null });
      await deny(server, type, { ...clear, [PREVIOUS]: null }, key(ALICE));
      await deny(server, type, { ...clear, [PREVIOUS]: null }, key(ADMIN));
      await roles(server, grants, true); await deny(server, type, { ...clear, [PREVIOUS]: revision }); await roles(server, grants);
      assert.equal(checked(await native(admin, roomPath(server) + '/redact/' + encodeURIComponent(revision) + '/' + randomBytes(12).toString('hex'), {}, 'PUT'), 403, 'Protect native moderation redaction').errcode, 'M_FORBIDDEN');
      if (type !== TYPES[2]) {
        // Rejection only: this opaque, synthetic payload must never persist or
        // be presented as decryptable E2EE content. No pre-existing text is read.
        const denied = await native(bob, roomPath(channel) + '/send/m.room.encrypted/' + randomBytes(12).toString('hex'),
          { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'ci-authorization-rejection-only', session_id: 'ci', device_id: bobSession.deviceId, sender_key: 'ci' }, 'PUT');
        assert.equal(checked(denied, 403, 'Inherit server restriction on native child writes').errcode, 'M_FORBIDDEN');
      }
      if (type === TYPES[1]) await deny(channel, 'm.room.member', { membership: 'join' }, BOB, bob);
      const cleared = await put(server, type, { ...clear, [PREVIOUS]: revision }, alice, key(BOB));
      await deny(server, type, { ...content, [PREVIOUS]: revision });
      assert.notEqual(cleared, revision);
    }
    assert.deepEqual(stableEvent((await inspect(server)).find('m.room.member', BOB)), memberBefore, 'Moderator metadata never impersonates the member profile or changes membership.');
  } catch (error) { failure = error; }
  finally {
    const errors = [], recover = async fn => { try { await fn(); } catch (error) { errors.push(error); } };
    for (const [id, fixture] of [...rooms].reverse()) if (fixture.verified) await recover(async () => {
      const { events } = await inspect(id);
      for (const item of events.filter(item => TYPES.includes(item.type))) {
        assert.equal(item.state_key, key(BOB));
        const clear = item.type === TYPES[0] ? { until: 0 } : item.type === TYPES[1] ? { version: 1, until: 0 } : { version: 1, name: null };
        if (item.content.until !== 0 && item.content.name !== null) await put(id, item.type, { ...clear, [PREVIOUS]: item.event_id }, admin, key(BOB));
      }
    });
    for (const [id, fixture] of [...rooms].reverse()) if (fixture.verified) await recover(async () => {
      await inspect(id); await leave(id, bob, BOB); await leave(id, alice, ALICE); await leave(id, admin, ADMIN);
    });
    for (const [page, saved] of preferences) await recover(async () => { await session(page); checked(await api(page, '/api/social/invitation-privacy', { invitations: saved }, false, false, 'PUT'), 200, 'Restore invitation preference'); });
    if (errors.length) failure = new AggregateError(failure ? [failure, ...errors] : errors, 'Native moderation probe or fixture cleanup failed.');
  }
  if (failure) throw failure;
  console.log('PASS: ordinary native moderator timeout, temporary ban and nickname writes use stable-room-safe keys; roles, hierarchy, stale revisions, inherited child restrictions and protected redaction hold. Member profiles remain intact.');
}
