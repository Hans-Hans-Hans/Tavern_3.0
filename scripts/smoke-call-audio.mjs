// Actual Synapse state requests from ordinary accounts. Requires the native
// audio flag enabled at stack startup; never changes deployment configuration.
// The read-only Tavern endpoint proves inherited projection, not media delivery.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertCiRoomCreation, isCiRoomId } from './ci-room-id.mjs';
import { matrixSmokeCreateFixture, matrixSmokeInvite, matrixSmokeJoin, matrixSmokeLeave, matrixSmokeRequest } from './matrix-smoke-request.mjs';

const ORIGIN = 'https://chat.example.test', ADMIN = '@ciadmin:chat.example.test';
const ALICE = '@cialice:chat.example.test', BOB = '@cibob:chat.example.test';
const AUDIO = 'io.tavern.call.audio', ROLES = 'io.tavern.roles', PREVIOUS = 'io.tavern.previous_event', MARKER = 'io.tavern.ci_audio';
const MODES = ['everyone', 'contacts', 'shared_server', 'nobody'];
const audioKey = target => { assert.ok([ADMIN, ALICE, BOB].includes(target)); return '_' + target.slice(1); };
const flags = (muted, deafened, previous = null) => ({ version: 1, muted, deafened, [PREVIOUS]: previous });

export async function callAudioSmoke({ admin, alice, bob, adminSession, aliceSession, bobSession, origin, api }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls' || origin !== ORIGIN
      || adminSession?.userId !== ADMIN || adminSession.admin !== true || !adminSession.deviceId
      || aliceSession?.userId !== ALICE || aliceSession.admin !== false || !aliceSession.deviceId
      || bobSession?.userId !== BOB || bobSession.admin !== false || !bobSession.deviceId || typeof api !== 'function') {
    throw new Error('Audio moderation acceptance requires the exact isolated CI stack and owning accounts.');
  }
  const owners = new Map([[admin, adminSession], [alice, aliceSession], [bob, bobSession]]);
  assert.equal(owners.size, 3, 'Three distinct owning browsers are required.');
  assert.equal(new Set([...owners.keys()].map(page => page.context())).size, 3, 'Each account requires its own browser context.');
  const runId = randomBytes(12).toString('hex'), fixtures = new Map(), savedPrivacy = new Map(), changedPrivacy = new Set();
  const checked = (response, expected, description) => {
    assert.equal(response.status, expected, description + ': ' + (response.data?.errcode || 'unexpected status'));
    return response.data;
  };
  const forbidden = (response, description) => assert.equal(checked(response, 403, description).errcode, 'M_FORBIDDEN');
  async function session(page) {
    assert.equal(new URL(page.url()).origin, ORIGIN, 'Use only an isolated owning browser.');
    const expected = owners.get(page); assert.ok(expected);
    const current = checked(await matrixSmokeRequest(() => api(page, '/api/auth/session')), 200, 'Read current owning CI session');
    for (const key of ['userId', 'deviceId', 'admin']) assert.equal(current[key], expected[key], 'The owning CI account/session changed.');
  }
  const native = async (page, path, body, method) => {
    assert.equal(new URL(page.url()).origin, ORIGIN);
    if (body !== undefined) await session(page);
    const request = () => api(page, '/_matrix/client/v3' + path, body, true, false, method);
    return body === undefined || method === 'PUT' ? matrixSmokeRequest(request) : request();
  };
  const room = id => { assert.ok(isCiRoomId(id) && fixtures.get(id)?.verified, 'Mutate only a proven fixture from this run.'); return '/rooms/' + encodeURIComponent(id); };
  const state = (id, type, key = '') => room(id) + '/state/' + encodeURIComponent(type) + '/' + encodeURIComponent(key);
  async function inspect(id, initial = false) {
    assert.ok(isCiRoomId(id) && fixtures.has(id));
    await session(admin);
    const fixture = fixtures.get(id), events = checked(await native(admin, '/rooms/' + encodeURIComponent(id) + '/state'), 200, 'Inspect native audio fixture creation');
    const find = assertCiRoomCreation({ id, events, creator: ADMIN, name: fixture.name, space: fixture.space, marker: MARKER, runId });
    assert.equal(find('m.room.join_rules')?.content.join_rule, 'invite');
    for (const member of events.filter(item => item.type === 'm.room.member')) assert.ok([ADMIN, ALICE, BOB].includes(member.state_key), 'No outside account belongs in an isolated audio fixture.');
    if (initial) {
      assert.deepEqual(events.filter(item => item.type === 'm.room.member').map(item => [item.state_key, item.content.membership]), [[ADMIN, 'join']]);
      assert.equal(find(AUDIO, audioKey(BOB)), undefined); assert.equal(find(ROLES), undefined);
      const powers = find('m.room.power_levels')?.content; assert.ok(powers);
      assert.equal(powers.users?.[ALICE] ?? powers.users_default ?? 0, 0);
      assert.equal(powers.users?.[BOB] ?? powers.users_default ?? 0, 0);
      fixture.originalPowers = structuredClone(powers);
    }
    if (!fixture.space) {
      assert.equal(find('m.room.encryption')?.content.algorithm, 'm.megolm.v1.aes-sha2');
      assert.equal(find('m.room.history_visibility')?.content.history_visibility, 'joined');
    }
    fixture.verified = true;
    return { events, find };
  }
  async function create(label, space, parent) {
    await session(admin);
    if (parent) room(parent);
    const name = 'CI audio moderation ' + label + ' ' + runId;
    const id = checked(await matrixSmokeCreateFixture(body => native(admin, '/createRoom', body), {
      name, visibility: 'private', preset: 'private_chat', creation_content: { 'm.federate': false, [MARKER]: runId, ...(space ? { type: 'm.space' } : {}) },
      initial_state: space ? [] : [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
        { type: 'm.space.parent', state_key: parent, content: { canonical: true, via: ['chat.example.test'] } },
      ],
    }), 200, 'Create fresh audio fixture without invitation side effects').room_id;
    assert.ok(isCiRoomId(id) && !fixtures.has(id)); fixtures.set(id, { name, space, verified: false });
    await inspect(id, true); return id;
  }
  async function put(id, type, data, description, page = admin, key = '') {
    const result = checked(await native(page, state(id, type, type === AUDIO ? audioKey(key) : key), data, 'PUT'), 200, description);
    assert.ok(typeof result.event_id === 'string' && result.event_id.startsWith('$'));
    assert.deepEqual(checked(await native(admin, state(id, type, type === AUDIO ? audioKey(key) : key)), 200, 'Read the actual accepted native state'), data);
    return result.event_id;
  }
  async function join(id, page, user) {
    await inspect(id); await session(page);
    const member = () => native(admin, state(id, 'm.room.member', user));
    checked(await matrixSmokeInvite(member, () => native(admin, room(id) + '/invite', { user_id: user })), 200, 'Invite only the known CI fixture member');
    checked(await matrixSmokeJoin(member, () => native(page, '/join/' + encodeURIComponent(id), {})), 200, 'Join the exact proven audio fixture');
  }
  async function leave(id, page, user) {
    await session(page);
    const current = await native(admin, state(id, 'm.room.member', user));
    if (current.status === 404 && current.data?.errcode === 'M_NOT_FOUND') return;
    checked(await matrixSmokeLeave(() => native(admin, state(id, 'm.room.member', user)),
      () => native(page, room(id) + '/leave', {})), 200, 'Leave only the proven audio fixture');
  }
  async function policy(id, grants, peer = false) {
    const { find } = await inspect(id);
    return put(id, ROLES, { version: 1, owner: ADMIN, roles: [
      { id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages', 'join_calls', 'invite'] },
      { id: 'moderator', name: 'Audio moderator', position: 50, permissions: grants },
    ], members: { [ALICE]: ['moderator'], ...(peer ? { [BOB]: ['moderator'] } : {}) }, overrides: {}, categoryOverrides: {},
    [PREVIOUS]: find(ROLES)?.event_id ?? null }, 'Set exact native audio role authority');
  }
  async function audio(id, muted, deafened, page = alice) {
    const { find } = await inspect(id);
    return put(id, AUDIO, flags(muted, deafened, find(AUDIO, audioKey(BOB))?.event_id ?? null), 'Save native audio flags (requires enabled startup configuration)', page, BOB);
  }
  async function deniedAudio(id, data, description, target = BOB) {
    // Synapse's unsigned.age changes between reads without changing the event.
    const stable = event => event && Object.fromEntries(['event_id', 'type', 'state_key', 'sender', 'content'].map(field => [field, event[field]]));
    const before = stable((await inspect(id)).find(AUDIO, audioKey(target)));
    forbidden(await native(alice, state(id, AUDIO, audioKey(target)), data, 'PUT'), description);
    assert.deepEqual(stable((await inspect(id)).find(AUDIO, audioKey(target))), before, 'Rejected direct state must not replace the accepted flags or revision.');
  }
  async function projection(id, expectedLocal, expectedEffective) {
    room(id); await session(alice);
    const data = checked(await matrixSmokeRequest(() => api(alice, '/api/calls/audio/' + encodeURIComponent(id) + '/' + encodeURIComponent(BOB))), 200, 'Read inherited native audio intent');
    assert.equal(data.roomId, id); assert.equal(data.userId, BOB);
    assert.deepEqual(data.local, expectedLocal); assert.deepEqual(data.effective, expectedEffective);
    assert.ok(data.scopes.every(scope => fixtures.get(scope.roomId)?.verified), 'Inherited names must belong only to proven fixture scopes.');
    return data;
  }
  for (const page of owners.keys()) await session(page);
  let failure;
  try {
    for (const page of [alice, bob]) {
      const saved = checked(await api(page, '/api/social/invitation-privacy'), 200, 'Read existing isolated invitation preference').invitations;
      assert.ok(MODES.includes(saved)); savedPrivacy.set(page, saved);
      if (saved !== 'everyone') {
        changedPrivacy.add(page); await session(page);
        checked(await api(page, '/api/social/invitation-privacy', { invitations: 'everyone' }, false, false, 'PUT'), 200, 'Allow isolated fixture setup');
      }
    }
    const ancestor = await create('ancestor', true), server = await create('server', true), channel = await create('channel', false, server);
    await put(server, 'm.space.parent', { canonical: true, via: ['chat.example.test'] }, 'Bind server to its true ancestor', admin, ancestor);
    await put(ancestor, 'm.space.child', { via: ['chat.example.test'] }, 'Publish reciprocal server ancestry', admin, server);
    await put(server, 'm.space.child', { via: ['chat.example.test'] }, 'Publish reciprocal audio channel', admin, channel);
    await put(channel, 'io.tavern.channel', { version: 1, kind: 'voice', archived: false, slowModeSeconds: 0 }, 'Configure encrypted fixture voice channel');
    for (const id of [ancestor, server, channel]) {
      await join(id, alice, ALICE); await join(id, bob, BOB);
      await put(id, 'm.room.power_levels', { ...fixtures.get(id).originalPowers,
        users: { ...fixtures.get(id).originalPowers.users, [ALICE]: id === ancestor ? 0 : 50, [BOB]: 0 } }, 'Give bounded native channel/server moderation authority');
    }
    await policy(ancestor, []); await policy(server, []);
    await deniedAudio(channel, flags(true, false), 'Native state power alone cannot bypass a missing custom mute grant');
    await policy(ancestor, ['mute_members']); await policy(server, ['mute_members']);
    const firstMute = await audio(channel, true, false);
    await deniedAudio(channel, flags(true, true, firstMute), 'Mute permission does not grant deafen permission');
    await policy(ancestor, ['mute_members', 'deafen_members']); await policy(server, ['mute_members', 'deafen_members']);
    const both = await audio(channel, true, true);
    await deniedAudio(channel, flags(false, false, firstMute), 'A stale draft from the same ordinary account cannot clear a newer flag');
    await policy(ancestor, ['mute_members']);
    const keptDeafen = await audio(channel, false, true);
    await deniedAudio(channel, flags(false, false, keptDeafen), 'Changing one flag cannot clear the other without its permission');
    await policy(ancestor, ['mute_members', 'deafen_members']);
    let cleared = await audio(channel, false, false);

    await deniedAudio(channel, flags(true, false), 'The native creator remains above a delegated ordinary moderator', ADMIN);
    await deniedAudio(channel, flags(true, false), 'A delegated moderator cannot change its own server audio state', ALICE);
    const baselinePowers = (await inspect(channel)).find('m.room.power_levels').content;
    await put(channel, 'm.room.power_levels', { ...baselinePowers, users: { ...baselinePowers.users, [BOB]: 50 } }, 'Temporarily establish an equal native target');
    await deniedAudio(channel, flags(true, false, cleared), 'Custom authority cannot bypass equal native target power');
    await put(channel, 'm.room.power_levels', baselinePowers, 'Restore lower native target authority');
    await policy(server, ['mute_members', 'deafen_members'], true);
    await deniedAudio(channel, flags(true, false, cleared), 'Native authority cannot bypass an equal custom target role');
    await policy(server, ['mute_members', 'deafen_members']);
    await put(channel, 'm.room.power_levels', { ...baselinePowers, kick: 75 }, 'Raise the actual native moderation ceiling');
    await deniedAudio(channel, flags(true, false, cleared), 'Audio moderation respects the current native kick ceiling');
    await put(channel, 'm.room.power_levels', baselinePowers, 'Restore the native moderation ceiling');
    await policy(ancestor, ['deafen_members']);
    await deniedAudio(channel, flags(true, false, cleared), 'A managed immediate server cannot hide a higher canonical ancestor denial');
    await policy(ancestor, ['mute_members', 'deafen_members']);
    await leave(ancestor, alice, ALICE);
    await deniedAudio(channel, flags(true, false, cleared), 'Child native authority does not bypass lost ancestor membership');
    await join(ancestor, alice, ALICE);

    await audio(server, true, false, admin); await audio(ancestor, false, true, admin);
    let inherited = await projection(channel, { muted: false, deafened: false }, { muted: true, deafened: true });
    assert.deepEqual(new Set(inherited.scopes.map(scope => scope.roomId)), new Set([ancestor, server, channel]));
    await audio(channel, true, false); cleared = await audio(channel, false, false);
    await projection(channel, { muted: false, deafened: false }, { muted: true, deafened: true });
    forbidden(await native(alice, state(channel, 'm.space.parent', server), {}, 'PUT'), 'A child moderator cannot detach inherited restriction authority');
    for (const id of [ancestor, server, channel]) {
      const revision = (await inspect(id)).find(AUDIO, audioKey(BOB))?.event_id; assert.ok(revision);
      forbidden(await native(admin, room(id) + '/redact/' + encodeURIComponent(revision) + '/' + randomBytes(12).toString('hex'), {}, 'PUT'), 'Even the native creator must explicitly clear audio flags instead of redacting them');
    }
    await deniedAudio(channel, { ...flags(true, false, cleared), canSubscribe: false }, 'Overbroad native audio writes cannot add unrelated media powers');
    await audio(channel, true, true);
    await leave(channel, bob, BOB);
    const departed = await audio(channel, false, true);
    await deniedAudio(channel, flags(true, true, departed), 'A departed target cannot acquire a new audio restriction');
    await audio(channel, false, false);
    await projection(channel, { muted: false, deafened: false }, { muted: true, deafened: true });
    assert.ok(both && cleared);
  } catch (error) { failure = error; }
  finally {
    const cleanup = [];
    const recover = async action => { try { await action(); } catch (error) { cleanup.push(error); } };
    // Only fixtures whose immutable creation was proved can be touched here.
    // Read actual revisions so an ambiguous earlier response is never replayed.
    for (const [id, fixture] of [...fixtures].reverse()) if (fixture.verified) await recover(async () => {
      const { events } = await inspect(id);
      for (const item of events.filter(event => event.type === AUDIO)) {
        const target = '@' + item.state_key.slice(1);
        assert.ok([ALICE, BOB].includes(target) && item.state_key === audioKey(target));
        if (item.content.muted !== false || item.content.deafened !== false) await put(id, AUDIO, flags(false, false, item.event_id), 'Explicitly clear isolated audio restrictions', admin, target);
      }
    });
    for (const [id, fixture] of [...fixtures].reverse()) if (fixture.verified) await recover(async () => {
      await inspect(id);
      for (const [page, user] of [[bob, BOB], [alice, ALICE]]) await leave(id, page, user);
      await session(admin);
      checked(await matrixSmokeLeave(() => native(admin, state(id, 'm.room.member', ADMIN)),
        () => native(admin, room(id) + '/leave', {})), 200, 'Release the fresh fixture creator membership');
    });
    for (const page of changedPrivacy) await recover(async () => {
      await session(page);
      checked(await api(page, '/api/social/invitation-privacy', { invitations: savedPrivacy.get(page) }, false, false, 'PUT'), 200, 'Restore the original isolated invitation preference');
    });
    if (cleanup.length) failure = new AggregateError(failure ? [failure, ...cleanup] : cleanup, 'Native audio probe or isolated fixture recovery failed.');
  }
  if (failure) throw failure;
  console.log('PASS: actual Synapse audio state enforces independent granular permissions, native/custom hierarchy, stale revisions, ancestor grants/membership, departed-target clear and redaction protection; read-only projection preserves inherited flags after child clear. Fixture members leave and temporary invitation preferences are restored. No media delivery or disabled-startup behavior is claimed.');
}
