// Native plaintext profile metadata only; no message content or media is classified.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isCiRoomId, assertCiRoomCreation } from './ci-room-id.mjs';
import { matrixSmokeRequest } from './matrix-smoke-request.mjs';

export async function profilePolicySmoke({ admin, alice, adminSession, aliceSession, fixture, origin, api }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls' || origin !== 'https://chat.example.test'
    || adminSession.userId !== '@ciadmin:chat.example.test' || adminSession.admin !== true
    || aliceSession.userId !== '@cialice:chat.example.test' || aliceSession.admin !== false
    || ![fixture?.server, fixture?.voice].every(isCiRoomId) || !/^[a-f0-9]{24}$/.test(fixture?.runId || '')
    || !adminSession.deviceId || !aliceSession.deviceId || [admin, alice].some(page => new URL(page.url()).origin !== origin)
    || fixture.server === fixture.voice) throw new Error('Profile policy smoke requires the isolated CI accounts and AFK fixture.');
  const { server, voice } = fixture, policyType = 'io.tavern.server.profile_policy', extension = 'io.tavern.profile';
  const native = (page, path, body, method) => {
    assert.equal(new URL(page.url()).origin, origin);
    const request = () => api(page, '/_matrix/client/v3' + path, body, true, false, method);
    return body === undefined || method === 'PUT' ? matrixSmokeRequest(request) : request();
  };
  const room = id => '/rooms/' + encodeURIComponent(id);
  const state = (id, type, key = '') => room(id) + '/state/' + encodeURIComponent(type) + '/' + encodeURIComponent(key);
  const checked = (response, status, description) => {
    assert.equal(response.status, status, description + ': ' + (response.data?.error || response.data?.errcode || 'unexpected status'));
    return response.data;
  };
  const forbidden = (response, description, reason) => {
    const result = checked(response, 403, description); assert.equal(result.errcode, 'M_FORBIDDEN');
    if (reason) assert.match(result.error, reason, description + ' must be denied for the actual profile rule.');
  };
  for (const [page, expected] of [[admin, adminSession], [alice, aliceSession]]) {
    const current = checked(await matrixSmokeRequest(() => api(page, '/api/auth/session')), 200, 'Inspect isolated account session');
    assert.equal(current.userId, expected.userId); assert.equal(current.deviceId, expected.deviceId); assert.equal(current.admin, expected.admin);
  }
  const original = new Map();
  for (const [id, name, space] of [[server, 'CI AFK settings server', true], [voice, 'CI AFK voice destination', false]]) {
    const all = checked(await native(admin, room(id) + '/state'), 200, 'Inspect authoritative isolated fixture state');
    assertCiRoomCreation({ id, events: all, creator: adminSession.userId, name, space, marker: 'io.tavern.ci_afk', runId: fixture.runId });
    const entry = (type, key = '') => all.find(item => item.type === type && item.state_key === key);
    const create = entry('m.room.create'); assert.equal(create?.sender, adminSession.userId); assert.equal(create.content['m.federate'], false);
    assert.equal(create.content.type === 'm.space', space); assert.equal(entry('m.room.name')?.content.name, name);
    assert.equal(entry('m.room.member', adminSession.userId)?.content.membership, 'join');
    assert.equal(entry('m.room.member', aliceSession.userId)?.content.membership, 'join');
    assert.equal(entry(policyType), undefined, 'Only a fresh fixture without existing profile rules is eligible for this probe.');
    original.set(id, { membership: entry('m.room.member', aliceSession.userId).content,
      administrator: entry('m.room.member', adminSession.userId).content, joinRules: entry('m.room.join_rules').content,
      powers: entry('m.room.power_levels').content });
    if (space) {
      const roles = entry('io.tavern.roles')?.content; assert.equal(roles?.owner, adminSession.userId);
      assert.equal(roles.roles.some(role => role.permissions.includes('manage_server')), false);
      assert.deepEqual(roles.members, {});
      assert.equal(entry('m.room.power_levels').content.users[adminSession.userId], 100);
      assert.equal(entry('m.room.power_levels').content.users[aliceSession.userId], 100);
      const recovered = entry('io.tavern.server.eligibility')?.content;
      assert.equal(recovered?.requireVerifiedEmail, false); assert.equal(recovered.minimumAccountAgeSeconds, 0);
      assert.ok(entry('m.space.child', voice)?.content.via?.length);
    } else {
      assert.equal(entry('io.tavern.channel')?.content.kind, 'text');
      assert.equal(entry('m.space.parent', server)?.content.canonical, true);
      assert.ok(entry('m.space.parent', server)?.content.via?.length);
    }
  }
  const permissive = { version: 1, enabled: true, allowLinks: true, allowCustomFields: true, maxBioLength: 1000, maxStatusLength: 160 };
  let revision = null, started = false, joinRulesChanged = false, membershipChanged = false;
  const save = async rules => {
    const content = { ...rules, 'io.tavern.previous_event': revision };
    const result = checked(await native(admin, state(server, policyType), content, 'PUT'), 200, 'Write protected native profile configuration');
    assert.ok(typeof result.event_id === 'string' && result.event_id.startsWith('$')); revision = result.event_id;
    assert.deepEqual(checked(await native(alice, state(server, policyType)), 200, 'Read persisted native profile configuration'), content);
    return content;
  };
  const membership = id => state(id, 'm.room.member', aliceSession.userId);
  const publish = (id, profile) => native(alice, membership(id), { ...original.get(id).membership, membership: 'join', [extension]: profile }, 'PUT');
  const stored = async id => checked(await native(admin, membership(id)), 200, 'Read actual native member profile');
  let failure;
  try {
    started = true;
    const first = await save(permissive);
    forbidden(await native(alice, state(server, policyType), { ...first, enabled: false, 'io.tavern.previous_event': revision }, 'PUT'), 'Native state power100 cannot replace custom manage_server authority');
    forbidden(await native(admin, state(server, policyType), { ...first, enabled: false }, 'PUT'), 'A stale profile configuration revision is rejected');
    forbidden(await native(admin, state(server, policyType), { ...first, maxBioLength: 161, 'io.tavern.previous_event': revision }, 'PUT'), 'An unbounded bio choice is rejected');
    forbidden(await native(admin, state(voice, policyType), first, 'PUT'), 'A channel cannot become a profile configuration authority');
    forbidden(await native(admin, room(server) + '/redact/' + encodeURIComponent(revision) + '/' + randomBytes(12).toString('hex'), {}, 'PUT'), 'Profile configuration cannot be redacted');
    const nativePowers = original.get(server).powers;
    forbidden(await native(admin, state(server, 'm.room.power_levels'),
      { ...nativePowers, events: { ...nativePowers.events, [policyType]: 101 } }, 'PUT'), 'Custom owner authority cannot raise profile state powers above its native ceiling');
    assert.deepEqual(checked(await native(admin, state(server, 'm.room.power_levels')), 200, 'Inspect unchanged native profile authority'), nativePowers);
    const rich = { version: 1, bio: '\u{1f600}'.repeat(80), status: '\u{1f600}'.repeat(20), statusEmoji: '\u{1f600}',
      links: [{ label: 'CI profile', url: 'https://example.test/profile' }], fields: [{ label: 'CI fixture', value: 'Native metadata acceptance' }] };
    membershipChanged = true;
    for (const id of [server, voice]) {
      checked(await publish(id, rich), 200, 'Publish valid native structured profile metadata');
      assert.deepEqual((await stored(id))[extension], rich);
    }
    const strict = { ...permissive, allowLinks: false, allowCustomFields: false, maxBioLength: 160, maxStatusLength: 40 };
    await save(strict);
    assert.deepEqual((await stored(voice))[extension], rich, 'Tightening rules does not erase previously published metadata.');
    const compliant = { ...rich, links: [], fields: [] };
    for (const id of [server, voice]) {
      checked(await publish(id, compliant), 200, 'A bounded UTF16 self-profile is allowed on the server and inherited channel');
      const saved = await stored(id); assert.deepEqual(saved[extension], compliant);
      assert.deepEqual(saved, { ...original.get(id).membership, membership: 'join', [extension]: compliant }, 'Unrelated native membership fields survive publication.');
    }
    for (const [changes, reason] of [
      [{ links: rich.links }, /does not allow profile links/], [{ fields: rich.fields }, /does not allow custom profile fields/],
      [{ bio: '\u{1f600}'.repeat(81) }, /limits profile bio to 160/], [{ status: '\u{1f600}'.repeat(21) }, /limits profile status to 40/],
      [{ links: [{ label: 'Unsafe', url: 'https://user:password@example.test/' }] }, /without credentials/],
    ]) {
      forbidden(await publish(voice, { ...compliant, ...changes }), 'Direct native self-membership cannot bypass profile rules', reason);
      assert.deepEqual((await stored(voice))[extension], compliant, 'Rejected metadata must not replace the accepted native profile.');
    }
    // Native room membership remains an independent identity boundary, even
    // for Alice's high native Space power. No other member profile is changed.
    forbidden(await native(alice, state(server, 'm.room.member', adminSession.userId),
      { ...original.get(server).administrator, membership: 'join', [extension]: compliant }, 'PUT'), 'A member cannot publish another account\'s joined profile');
    assert.deepEqual(checked(await native(admin, state(server, 'm.room.member', adminSession.userId)), 200, 'Read unchanged administrator membership'), original.get(server).administrator);
    await save({ ...strict, maxStatusLength: 0 });
    forbidden(await publish(voice, { ...compliant, status: '' }), 'A zero status limit also rejects an emoji-only status', /Remove the status emoji/);
    checked(await publish(voice, { ...compliant, status: '', statusEmoji: '', statusUntil: 0 }), 200, 'Clear a disabled status without blocking the rest of the profile');

    // Public readmission applies only to the already verified non-federated CI
    // channel, and is restored below. No invitation or account is created.
    joinRulesChanged = true;
    checked(await native(admin, state(voice, 'm.room.join_rules'), { join_rule: 'public' }, 'PUT'), 200, 'Allow isolated profileless native readmission');
    const basic = { ...original.get(voice).membership, membership: 'join' }; delete basic[extension];
    checked(await native(alice, membership(voice), basic, 'PUT'), 200, 'Remove the extension without blocking native membership');
    assert.equal(Object.hasOwn(await stored(voice), extension), false);
    checked(await native(alice, membership(voice), { ...basic, membership: 'leave', [extension]: rich }, 'PUT'), 200, 'Self-leave remains allowed with an older now-forbidden profile');
    assert.equal((await stored(voice)).membership, 'leave');
    checked(await native(alice, membership(voice), basic, 'PUT'), 200, 'A fresh profileless native join remains allowed');
    assert.deepEqual(await stored(voice), basic);
  } catch (error) { failure = error; }
  finally {
    const cleanup = [];
    const recover = async action => { try { await action(); } catch (error) { cleanup.push(error); } };
    if (started) await recover(async () => {
      // Read the actual revision even after an ambiguous write. Recovery never
      // replays that write; it submits a new disabled policy against known state.
      const all = checked(await native(admin, room(server) + '/state'), 200, 'Read current profile revision for fixture recovery');
      const saved = all.find(item => item.type === policyType && item.state_key === '');
      if (saved) {
        assert.ok(typeof saved.event_id === 'string' && saved.event_id.startsWith('$')); revision = saved.event_id;
        await save({ ...permissive, enabled: false });
      }
    });
    if (membershipChanged) for (const id of [server, voice]) await recover(async () => {
      checked(await native(alice, membership(id), original.get(id).membership, 'PUT'), 200, 'Restore original native membership data');
      assert.deepEqual(await stored(id), original.get(id).membership);
    });
    if (joinRulesChanged) await recover(async () => {
      checked(await native(admin, state(voice, 'm.room.join_rules'), original.get(voice).joinRules, 'PUT'), 200, 'Restore original native channel admission');
      assert.deepEqual(checked(await native(admin, state(voice, 'm.room.join_rules')), 200, 'Read restored channel admission'), original.get(voice).joinRules);
    });
    if (cleanup.length) failure = new AggregateError(failure ? [failure, ...cleanup] : cleanup, 'Profile policy probe or fixture recovery failed.');
  }
  if (failure) throw failure;
  console.log('PASS: actual Synapse profile rules enforce custom authority, strict revisions and protected configuration; preserve valid UTF16 metadata; deny direct forbidden links, fields, bio, status and emoji; allow profileless join and leave; retain prior history and restore fixture memberships/admission with rules disabled. No encrypted content or media was inspected.');
}
