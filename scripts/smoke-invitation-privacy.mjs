// Native Synapse admission checks on freshly marked, isolated CI resources.
// The extra owning sender has no prior shared Spaces or contact relationship.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { matrixSmokeRequest, matrixSmokeJoin, matrixSmokeLeave, matrixSmokeCreateFixture } from './matrix-smoke-request.mjs';

const ORIGIN = 'https://chat.example.test', ADMIN = '@ciadmin:chat.example.test';
const BOB = '@cibob:chat.example.test', SENDER = '@ciinviter:chat.example.test';
const PRIVACY = 'io.tavern.privacy', IGNORED = 'm.ignored_user_list';
const ROOM_ID = /^![^\s/\\?#:]{1,200}:chat\.example\.test$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function invitationPrivacySmoke({ admin, bob, adminSession, bobSession, origin, api, createPage, login }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls' || origin !== ORIGIN
    || adminSession?.userId !== ADMIN || adminSession.admin !== true || !adminSession.deviceId
    || bobSession?.userId !== BOB || bobSession.admin !== false || !bobSession.deviceId
    || ![api, createPage, login].every(value => typeof value === 'function')) {
    throw new Error('Invitation privacy acceptance requires the exact isolated CI origin and owning accounts.');
  }
  const nonce = randomBytes(12).toString('hex'), fixtures = new Map();
  const checked = (response, description, status = 200) => {
    assert.equal(response.status, status, description + ': ' + (response.data?.errcode || response.data?.error || 'unexpected status'));
    return response.data;
  };
  async function session(page, expected) {
    assert.equal(new URL(page.url()).origin, ORIGIN, 'Only an isolated owning browser may inspect or mutate fixtures.');
    const current = checked(await matrixSmokeRequest(() => api(page, '/api/auth/session')), 'Read current CI session');
    assert.equal(current.userId, expected.userId); assert.equal(current.deviceId, expected.deviceId); assert.equal(current.admin, expected.admin);
  }
  const native = (page, path, body, method) => {
    assert.equal(new URL(page.url()).origin, ORIGIN);
    const request = () => api(page, '/_matrix/client/v3' + path, body, true, false, method);
    // Mutation retry belongs to the known-target helpers below, never createRoom.
    return body === undefined ? matrixSmokeRequest(request) : request();
  };
  const room = id => { assert.ok(ROOM_ID.test(id) && fixtures.has(id)); return '/rooms/' + encodeURIComponent(id); };
  const state = (id, type, key = '') => room(id) + '/state/' + encodeURIComponent(type) + '/' + encodeURIComponent(key);
  const accountPath = type => '/user/' + encodeURIComponent(BOB) + '/account_data/' + encodeURIComponent(type);
  async function account(type) {
    const result = await native(bob, accountPath(type));
    if (result.status === 404 && result.data?.errcode === 'M_NOT_FOUND') return {};
    const value = checked(result, 'Read recipient own native preferences'); assert.ok(object(value)); return value;
  }
  async function writeAccount(type, value) {
    assert.ok([PRIVACY, IGNORED].includes(type)); await session(bob, bobSession);
    checked(await matrixSmokeRequest(() => native(bob, accountPath(type), value, 'PUT')), 'Write only recipient own native preferences');
    assert.deepEqual(await account(type), value);
  }
  async function globalMode(mode) {
    assert.ok(['everyone', 'nobody', 'contacts', 'shared_server'].includes(mode)); await session(bob, bobSession);
    const result = checked(await api(bob, '/api/social/invitation-privacy', { invitations: mode }, false, false, 'PUT'), 'Save recipient global invitation choice');
    assert.equal(result.invitations, mode); assert.equal((await account(PRIVACY)).invitations, mode);
  }
  async function rules(servers) {
    assert.ok(object(servers));
    for (const id of Object.keys(servers)) { room(id); assert.equal(fixtures.get(id).space, true); }
    await session(bob, bobSession);
    const before = checked(await api(bob, '/api/social/server-invitation-privacy'), 'Read recipient current server-rule revision');
    assert.equal(before.invalid, false); assert.match(before.revision, /^[a-f0-9]{64}$/);
    const after = checked(await api(bob, '/api/social/server-invitation-privacy', { servers, revision: before.revision }, false, false, 'PUT'), 'Save recipient own server restrictions');
    assert.deepEqual(after.servers, servers); assert.deepEqual((await account(PRIVACY)).serverInvitations, servers);
  }
  await session(admin, adminSession); await session(bob, bobSession);
  const savedPrivacy = await account(PRIVACY), savedIgnored = await account(IGNORED);
  assert.ok(object(savedIgnored.ignored_users || {}));
  const socialBefore = checked(await api(bob, '/api/social'), 'Read recipient contact preference');
  assert.ok(['everyone', 'shared_server', 'nobody'].includes(socialBefore.privacy));
  assert.ok(Array.isArray(socialBefore.requests) && Array.isArray(socialBefore.blocked));
  assert.ok(!socialBefore.requests.some(row => row.sender === SENDER || row.target === SENDER));
  assert.ok(!socialBefore.blocked.includes(SENDER) && !Object.hasOwn(savedIgnored.ignored_users || {}, SENDER));
  const password = 'Ci!' + randomBytes(24).toString('base64url');
  await session(admin, adminSession); await session(bob, bobSession);
  checked(await api(admin, '/api/admin/users', { username: 'ciinviter', displayName: 'CI invitation sender', password }), 'Create only the dedicated CI sender', 201);
  const sender = await createPage(); await login(sender, 'ciinviter', password);
  const senderSession = checked(await api(sender, '/api/auth/session'), 'Inspect dedicated owning sender');
  assert.equal(senderSession.userId, SENDER); assert.equal(senderSession.admin, false); assert.ok(senderSession.deviceId);
  await session(sender, senderSession);
  let touchedPrivacy = false, touchedIgnored = false, touchedContactPreference = false, contactAttempted = false, contactId, failure;
  async function inspect(id) {
    await session(sender, senderSession);
    const events = checked(await native(sender, room(id) + '/state'), 'Inspect fresh marked native fixture');
    const find = type => events.find(event => event.type === type && event.state_key === '');
    const create = find('m.room.create');
    assert.equal(create.sender, SENDER); assert.equal(create.content['m.federate'], false);
    assert.equal(create.content['io.tavern.ci_invitation_privacy'], nonce);
    assert.equal(create.content.type === 'm.space', fixtures.get(id).space);
    assert.equal(find('m.room.name').content.name, fixtures.get(id).name);
    assert.equal(find('m.room.join_rules').content.join_rule, 'invite');
    assert.ok(events.filter(event => event.type === 'm.room.member').every(event => [SENDER, BOB].includes(event.state_key)));
    if (!fixtures.get(id).space) assert.equal(find('m.room.encryption').content.algorithm, 'm.megolm.v1.aes-sha2');
    return events;
  }
  async function create(label, space = false, parent) {
    await session(sender, senderSession);
    const name = 'CI invitation privacy ' + label + ' ' + nonce;
    if (parent) { room(parent); assert.equal(fixtures.get(parent).space, true); }
    const initial = space ? [] : [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ];
    if (parent) initial.push({ type: 'm.space.parent', state_key: parent, content: { canonical: true, via: ['chat.example.test'] } });
    const id = checked(await matrixSmokeCreateFixture(body => native(sender, '/createRoom', body), {
      name, visibility: 'private', preset: 'private_chat',
      creation_content: { 'm.federate': false, 'io.tavern.ci_invitation_privacy': nonce, ...(space ? { type: 'm.space' } : {}) }, initial_state: initial,
    }), 'Create exactly one fresh CI room without invitation side effects').room_id;
    assert.ok(ROOM_ID.test(id) && !fixtures.has(id)); fixtures.set(id, { name, space }); await inspect(id); return id;
  }
  const membership = (viewer, id, user) => { assert.ok([SENDER, BOB].includes(user)); return native(viewer, state(id, 'm.room.member', user)); };
  async function leave(page, id, expected) {
    await session(page, expected); room(id);
    // Bob can still read a Space while sender leaves; sender reads its own
    // conversation when the pending recipient declines. No forbidden read is
    // taken as proof that a leave persisted.
    const viewer = expected.userId === SENDER ? bob : sender;
    checked(await matrixSmokeLeave(() => membership(viewer, id, expected.userId), () => native(page, room(id) + '/leave', {})), 'Leave only the known isolated room');
    assert.equal(checked(await membership(viewer, id, expected.userId), 'Confirm native leave').membership, 'leave');
  }
  async function invite(id, allowed, forged = false, claim) {
    await session(sender, senderSession); await session(bob, bobSession); await inspect(id);
    if (claim) room(claim);
    const before = await membership(sender, id, BOB);
    assert.ok(before.status === 404 || before.status === 200 && before.data.membership === 'leave', 'Every admission test starts without an invitation or joined recipient.');
    const result = await matrixSmokeRequest(async () => {
      const current = await membership(sender, id, BOB);
      if (current.status === 200 && current.data.membership === 'invite') {
        assert.ok(allowed, 'A denied invitation must never have persisted.'); return current;
      }
      assert.ok(current.status === 404 || current.status === 200 && current.data.membership === 'leave');
      return forged
        ? native(sender, state(id, 'm.room.member', BOB), { membership: 'invite', is_direct: true, serverId: claim }, 'PUT')
        : native(sender, room(id) + '/invite', { user_id: BOB });
    });
    if (allowed) {
      checked(result, 'Native recipient policy permits this exact invitation');
      assert.equal(checked(await membership(sender, id, BOB), 'Confirm actual native invitation').membership, 'invite');
    } else {
      assert.equal(result.status, 403, 'Native admission must reject the restricted invitation.');
      assert.equal(result.data.errcode, 'M_FORBIDDEN');
      const after = await membership(sender, id, BOB);
      assert.equal(after.status, before.status); assert.deepEqual(after.data, before.data, 'A rejected request must not change recipient membership.');
    }
  }
  async function permitThenDecline(id, forged = false, claim) { await invite(id, true, forged, claim); await leave(bob, id, bobSession); }
  try {
    const first = await create('first server', true), second = await create('second server', true), target = await create('target', false, first);
    // A sender-authored canonical parent and is_direct marker cannot invent
    // recipient membership. The first sender has no previous shared Spaces.
    const a = checked(await native(sender, '/joined_rooms'), 'Read sender own membership').joined_rooms;
    const b = checked(await native(bob, '/joined_rooms'), 'Read recipient own membership').joined_rooms;
    assert.deepEqual(a.filter(id => b.includes(id)), []);
    touchedPrivacy = true; await rules({}); await globalMode('shared_server');
    await invite(target, false, true, first);
    await globalMode('everyone');
    for (const id of [first, second]) {
      await invite(id, true);
      checked(await matrixSmokeJoin(() => membership(sender, id, BOB), () => native(bob, '/join/' + encodeURIComponent(id), {})), 'Explicitly join recipient to fresh CI Space');
      assert.equal(checked(await membership(sender, id, BOB), 'Confirm actual shared Space membership').membership, 'join');
    }
    await globalMode('shared_server'); await permitThenDecline(target);
    console.log('PASS: native shared-server invitation consent requires actual joined Space membership; claimed parent/direct metadata cannot create it.');

    await globalMode('contacts'); await invite(target, false);
    if (socialBefore.privacy !== 'everyone') {
      touchedContactPreference = true;
      checked(await api(bob, '/api/social/privacy', { requests: 'everyone' }, false, false, 'PUT'), 'Allow isolated contact request');
    }
    await session(sender, senderSession); contactAttempted = true;
    const pending = checked(await api(sender, '/api/social/requests', { target: BOB }), 'Create one explicit CI contact request', 201);
    const request = pending.requests.find(row => row.sender === SENDER && row.target === BOB && row.status === 'pending');
    assert.ok(request && /^[A-Za-z0-9_-]{16,80}$/.test(request.id)); contactId = request.id;
    await invite(target, false, true, first);
    await session(bob, bobSession);
    const accepted = checked(await api(bob, '/api/social/requests/' + encodeURIComponent(contactId), { operation: 'accept' }, false, false, 'PATCH'), 'Recipient explicitly accepts CI contact');
    assert.ok(accepted.requests.some(row => row.id === contactId && row.status === 'accepted'));
    await permitThenDecline(target);
    console.log('PASS: native contacts-only admission rejects strangers and pending requests, then permits an explicitly accepted contact through the signed internal check.');

    await globalMode('everyone'); await rules({ [first]: 'contacts', [second]: 'nobody' });
    await invite(target, false, true, first);
    await rules({ [first]: 'contacts' }); await permitThenDecline(target);
    await globalMode('nobody'); await invite(target, false);
    await globalMode('everyone'); await rules({ [first]: 'nobody' }); await invite(target, false);
    await leave(sender, first, senderSession);
    await permitThenDecline(target, true, first);
    console.log('PASS: restrictions from both actual shared Spaces intersect with global consent; leaving the restricted Space removes only that Space rule despite a claimed target parent.');

    touchedIgnored = true;
    await writeAccount(IGNORED, { ...savedIgnored, ignored_users: { ...(savedIgnored.ignored_users || {}), [SENDER]: {} } });
    await invite(target, false, true, first);
    await writeAccount(IGNORED, savedIgnored); touchedIgnored = false;
    await permitThenDecline(target);
    console.log('PASS: the native ignored-user list rejects an otherwise permitted contact invitation and restoring it restores eligibility.');
  } catch (error) { failure = error; }
  finally {
    const cleanup = [];
    if (touchedIgnored) try { await writeAccount(IGNORED, savedIgnored); } catch { cleanup.push('native ignored users'); }
    if (touchedPrivacy) try { await writeAccount(PRIVACY, savedPrivacy); } catch { cleanup.push('native invitation privacy'); }
    if (contactAttempted) try {
      await session(bob, bobSession); await session(sender, senderSession);
      // Reconcile the actual relationship even if the POST/PATCH response was
      // lost. This freshly created sender cannot have a preexisting relation.
      const current = checked(await api(bob, '/api/social'), 'Read current CI contact cleanup state');
      const matches = current.requests.filter(row => row.sender === SENDER && row.target === BOB);
      assert.ok(matches.length <= 1);
      if (matches.length) {
        const value = matches[0]; assert.match(value.id, /^[A-Za-z0-9_-]{16,80}$/);
        if (value.status === 'accepted') checked(await api(bob, '/api/social/contacts/' + encodeURIComponent(SENDER), undefined, false, false, 'DELETE'), 'Remove only the new CI contact');
        else { assert.equal(value.status, 'pending'); checked(await api(sender, '/api/social/requests/' + encodeURIComponent(value.id), { operation: 'cancel' }, false, false, 'PATCH'), 'Cancel only the new CI contact request'); }
      }
      const after = checked(await api(bob, '/api/social'), 'Confirm only the new CI relationship was removed');
      assert.deepEqual(after.requests, socialBefore.requests);
    } catch { cleanup.push('new CI contact'); }
    if (touchedContactPreference) try {
      await session(bob, bobSession);
      checked(await api(bob, '/api/social/privacy', { requests: socialBefore.privacy }, false, false, 'PUT'), 'Restore recipient contact preference');
    } catch { cleanup.push('contact preference'); }
    if (cleanup.length) failure ||= new Error('Isolated invitation privacy cleanup failed: ' + cleanup.join(', '));
  }
  if (failure) throw failure;
}
