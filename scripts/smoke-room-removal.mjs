// Destructive acceptance is restricted to this run's three fresh native CI rooms.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { isCiRoomId, assertCiRoomCreation } from './ci-room-id.mjs';
import { matrixSmokeRequest, matrixSmokeCreateFixture } from './matrix-smoke-request.mjs';
const ORIGIN = 'https://chat.example.test', ACTOR = '@cialice:chat.example.test', MARKER = 'io.tavern.ci_room_removal';
export async function roomRemovalSmoke({ alice, aliceSession, origin, api }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls' || origin !== ORIGIN
      || aliceSession?.userId !== ACTOR || aliceSession.admin !== false || !aliceSession.deviceId) throw new Error('Room deletion requires the exact isolated CI account and stack.');
  const checked = (result, label, expected = 200) => { assert.equal(result.status, expected, label); return result.data; };
  const fixtures = new Map(), runId = randomBytes(12).toString('hex');
  async function session() {
    assert.equal(new URL(alice.url()).origin, ORIGIN);
    const actual = checked(await api(alice, '/api/auth/session'), 'Read exact deletion owner');
    assert.equal(actual.userId, ACTOR); assert.equal(actual.deviceId, aliceSession.deviceId); assert.equal(actual.admin, false);
  }
  async function native(path, body, method) {
    await session();
    return matrixSmokeRequest(() => api(alice, '/_matrix/client/v3' + path, body, true, false, method));
  }
  const room = id => { assert.ok(fixtures.has(id) && isCiRoomId(id)); return '/rooms/' + encodeURIComponent(id); };
  async function inspect(id) {
    const events = checked(await native(room(id) + '/state'), 'Inspect only fresh native deletion fixtures');
    const find = assertCiRoomCreation({ id, events, creator: ACTOR, marker: MARKER, runId, ...fixtures.get(id) });
    assert.ok(events.filter(event => event.type === 'm.room.member').every(event => event.state_key === ACTOR));
    return { events, find };
  }
  async function put(id, type, body, key = '') {
    await inspect(id);
    return checked(await native(room(id) + '/state/' + encodeURIComponent(type) + '/' + encodeURIComponent(key), body, 'PUT'), 'Save fresh fixture state');
  }
  async function create(label, space, parent) {
    await session(); if (parent) await inspect(parent);
    const name = 'CI removal ' + label + ' ' + runId;
    const initial = space ? [] : [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: 'm.space.parent', state_key: parent, content: { canonical: true, via: ['chat.example.test'] } }];
    const id = checked(await matrixSmokeCreateFixture(config => native('/createRoom', config), { name, preset: 'private_chat', visibility: 'private',
      creation_content: { 'm.federate': false, [MARKER]: runId, ...(space ? { type: 'm.space' } : {}) }, initial_state: initial }), 'Create fresh deletion fixture').room_id;
    assert.ok(isCiRoomId(id) && !fixtures.has(id)); fixtures.set(id, { name, space }); await inspect(id);
    if (parent) await put(parent, 'm.space.child', { via: ['chat.example.test'] }, id);
    return id;
  }
  await session();
  const server = await create('server', true), first = await create('channel one', false, server), second = await create('channel two', false, server);
  await put(server, 'io.tavern.roles', { version: 1, owner: ACTOR, roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages'] }], members: {}, overrides: {},
    channelAdmissionVersion: 1, channelAdmissions: { [first]: { roleIds: ['everyone'], userIds: [] } }, 'io.tavern.previous_event': null });
  await put(server, 'io.tavern.server.layout', { version: 1, categories: [{ id: 'games', name: 'Games' }], channels: [{ id: first, category: 'games' }, { id: second, category: '' }] });
  async function remove(root, expected) {
    for (const id of expected) await inspect(id);
    await session();
    const review = checked(await api(alice, '/api/rooms/' + encodeURIComponent(root) + '/removal-review', {}), 'Review only exact fresh rooms');
    assert.equal(review.roomId, root); assert.equal(review.name, fixtures.get(root).name); assert.equal(review.phase, 'review');
    assert.match(review.id, /^[A-Za-z0-9_-]{16,80}$/); assert.deepEqual(new Set(review.targets.map(item => item.id)), new Set(expected));
    assert.equal(review.targets.length, expected.length);
    for (const id of expected) await inspect(id);
    await session();
    const path = '/api/room-removals/' + review.id;
    let status = checked(await api(alice, path + '/confirm', { confirmation: fixtures.get(root).name }), 'Confirm exact reviewed fixture deletion');
    const until = Date.now() + 90000;
    while (status.phase !== 'complete') {
      assert.notEqual(status.phase, 'attention', 'Native deletion and parent cleanup must complete without forced purging or hidden retries.');
      assert.ok(Date.now() < until, 'Native deletion must finish within its bounded acceptance window.');
      await session();
      status = checked(await api(alice, path + '/continue', {}), 'Continue exact confirmed deletion');
      assert.deepEqual(status.targets.map(item => item.id), review.targets.map(item => item.id));
      if (status.phase !== 'complete') await pause(1000);
    }
    assert.equal(status.completed, expected.length);
    for (const id of expected) {
      const membership = await native(room(id) + '/state/m.room.member/' + encodeURIComponent(ACTOR));
      assert.ok([403, 404].includes(membership.status) || membership.data.membership === 'leave', 'Deleted native rooms must no longer expose joined membership.');
    }
    const saved = checked(await api(alice, path), 'Read durable completed deletion'); assert.equal(saved.phase, 'complete');
  }
  await remove(first, [first]);
  const remaining = await inspect(server);
  assert.equal(remaining.find('m.space.child', first)?.content.via, undefined);
  assert.equal(remaining.find('io.tavern.roles').content.channelAdmissions[first], undefined);
  assert.deepEqual(remaining.find('io.tavern.server.layout').content.channels, [{ id: second, category: '' }]);
  await remove(server, [second, server]);
  console.log('PASS: an ordinary native server owner reviews and permanently removes only fresh CI channels and their server; Synapse confirms purge, parent lists retain unrelated channels, and completed deletion records remain readable.');
}
