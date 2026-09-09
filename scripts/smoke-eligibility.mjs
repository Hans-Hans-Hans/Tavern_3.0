// Actual isolated Synapse enforcement; no account metadata or credentials are fabricated.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { matrixSmokeJoin, matrixSmokeRequest } from './matrix-smoke-request.mjs';

export async function eligibilitySmoke({ admin, alice, adminSession, aliceSession, fixture, encryptedProbe,
  origin, api, ready, encryptedResponse, encryptedEvent }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || origin !== 'https://chat.example.test'
    || adminSession.userId !== '@ciadmin:chat.example.test' || adminSession.admin !== true
    || aliceSession.userId !== '@cialice:chat.example.test' || aliceSession.admin !== false
    || ![fixture?.server, fixture?.voice].every(id => typeof id === 'string' && /^![^\s]+:chat\.example\.test$/.test(id))) {
    throw new Error('Eligibility smoke requires the isolated CI accounts and AFK fixture.');
  }
  const { server, voice } = fixture, eligibility = 'io.tavern.server.eligibility', callMember = 'org.matrix.msc3401.call.member';
  const native = (page, path, body, method) => {
    const request = () => api(page, '/_matrix/client/v3' + path, body, true, false, method);
    return body === undefined || method === 'PUT' ? matrixSmokeRequest(request) : request();
  };
  const room = id => '/rooms/' + encodeURIComponent(id);
  const state = (id, type, key = '') => room(id) + '/state/' + encodeURIComponent(type) + '/' + encodeURIComponent(key);
  const checked = (response, status, description) => {
    assert.equal(response.status, status, description + ': ' + (response.data?.error || response.data?.errcode || 'unexpected status'));
    return response.data;
  };
  const rejected = (response, reason, description) => {
    const data = checked(response, 403, description);
    assert.equal(data.errcode, 'M_FORBIDDEN');
    assert.match(data.error, reason, description + ' must fail for the actual eligibility rule.');
  };
  const currentSession = checked(await matrixSmokeRequest(() => api(alice, '/api/auth/session')), 200, 'Inspect current CI Alice account');
  assert.equal(currentSession.userId, aliceSession.userId);
  assert.equal(currentSession.emailVerified, false, 'This probe requires the actual unverified admin-created account.');
  for (const session of [adminSession, aliceSession]) {
    const detail = checked(await matrixSmokeRequest(() => api(admin, '/api/admin/users/' + encodeURIComponent(session.userId))), 200, 'Inspect native fixture account age');
    assert.equal(detail.user.name, session.userId);
    assert.equal(detail.user.deactivated, false);
    assert.ok(Number.isInteger(detail.user.creation_ts) && detail.user.creation_ts > 0);
    const age = Date.now() / 1000 - detail.user.creation_ts;
    assert.ok(age >= 0 && age < 604800, 'Only this run\'s fresh accounts can exercise the native seven-day requirement.');
  }
  const creation = checked(await native(admin, state(server, 'm.room.create')), 200, 'Inspect isolated server creation');
  assert.equal(creation.type, 'm.space'); assert.equal(creation['m.federate'], false);
  assert.equal(checked(await native(admin, state(server, 'm.room.name')), 200, 'Inspect isolated server name').name, 'CI AFK settings server');
  assert.equal(checked(await native(admin, state(voice, 'm.room.name')), 200, 'Inspect isolated channel name').name, 'CI AFK voice destination');
  assert.equal(checked(await native(admin, state(voice, 'io.tavern.channel')), 200, 'Inspect reused text channel').kind, 'text');
  assert.equal(checked(await native(admin, state(voice, 'm.space.parent', server)), 200, 'Inspect canonical parent').canonical, true);
  assert.ok(checked(await native(admin, state(server, 'm.space.child', voice)), 200, 'Inspect reciprocal child').via.length);
  const powers = checked(await native(admin, state(server, 'm.room.power_levels')), 200, 'Inspect native server authority');
  assert.equal(powers.users[aliceSession.userId], 100, 'Alice has native state authority but no custom manage_server permission.');
  const storedCiphertext = checked(await native(alice, room(encryptedProbe.roomId) + '/event/' + encodeURIComponent(encryptedProbe.eventId)), 200, 'Read an actual earlier encrypted test event');
  assert.equal(storedCiphertext.type, 'm.room.encrypted'); assert.ok(storedCiphertext.content.ciphertext);
  const encryptedAttempt = () => native(alice, room(voice) + '/send/m.room.encrypted/' + randomBytes(12).toString('hex'), storedCiphertext.content, 'PUT');
  // Reuse ciphertext only for rejected requests. Recovery below uses fresh SDK
  // encryption for this actual room, not ciphertext copied between rooms.
  let revision = null;
  const write = async (requireVerifiedEmail, minimumAccountAgeSeconds) => {
    const content = { version: 1, requireVerifiedEmail, minimumAccountAgeSeconds, 'io.tavern.previous_event': revision };
    const saved = checked(await native(admin, state(server, eligibility), content, 'PUT'), 200, 'Write current protected eligibility configuration');
    assert.ok(saved.event_id); revision = saved.event_id;
    assert.deepEqual(checked(await native(admin, state(server, eligibility)), 200, 'Read persisted eligibility configuration'), content);
    return content;
  };
  const disabled = await write(false, 0);
  checked(await native(alice, state(server, eligibility), { ...disabled, requireVerifiedEmail: true, 'io.tavern.previous_event': revision }, 'PUT'), 403, 'Native state power cannot replace custom manage_server authority');
  checked(await native(admin, state(server, eligibility), { ...disabled, requireVerifiedEmail: true }, 'PUT'), 403, 'Stale eligibility revision is rejected');
  checked(await native(admin, state(server, eligibility), { ...disabled, minimumAccountAgeSeconds: 42, 'io.tavern.previous_event': revision }, 'PUT'), 403, 'Unbounded age choices are rejected');
  checked(await native(admin, state(voice, eligibility), disabled, 'PUT'), 403, 'Eligibility cannot be installed on a child channel');
  checked(await native(admin, room(server) + '/redact/' + encodeURIComponent(revision) + '/' + randomBytes(12).toString('hex'), {}, 'PUT'), 403, 'Eligibility configuration cannot be redacted');

  const callPowers = checked(await native(admin, state(voice, 'm.room.power_levels')), 200, 'Read native channel call powers');
  const callPayload = { memberships: [{ application: 'm.call', scope: 'm.room', call_id: '', device_id: aliceSession.deviceId,
    expires: 60000, membershipID: 'ci-' + randomBytes(12).toString('hex'), foci_active: [] }] };
  const callWrite = content => native(alice, state(voice, callMember, aliceSession.userId), content, 'PUT');
  checked(await callWrite(callPayload), 403, 'Native state power still prevents call membership despite custom join_calls');
  checked(await native(admin, state(voice, 'm.room.power_levels'), { ...callPowers, events: { ...callPowers.events, [callMember]: 0 } }, 'PUT'), 200, 'Allow native call membership for this isolated probe');
  checked(await callWrite(callPayload), 200, 'Both native and custom call permissions allow membership before eligibility is enabled');
  // Public native join rules apply only to these non-federated CI rooms. They
  // let a departed member retry admission without an invitation-policy failure
  // obscuring the eligibility check. The rules are restored at the end.
  const joinRules = new Map();
  for (const id of [server, voice]) {
    joinRules.set(id, checked(await native(admin, state(id, 'm.room.join_rules')), 200, 'Record fixture join rules'));
    checked(await native(admin, state(id, 'm.room.join_rules'), { join_rule: 'public' }, 'PUT'), 200, 'Enable isolated native readmission probe');
  }
  const join = id => matrixSmokeJoin(
    () => native(alice, state(id, 'm.room.member', aliceSession.userId)),
    () => native(alice, '/join/' + encodeURIComponent(id), {}));
  await write(false, 604800);
  rejected(await encryptedAttempt(), /7 days/, 'A current member cannot send opaque ciphertext before the native account age threshold');
  rejected(await callWrite(callPayload), /7 days/, 'A young account cannot republish native call admission');
  checked(await callWrite({}), 200, 'A restricted member can remove its own existing call membership');
  for (const id of [voice, server]) {
    checked(await native(alice, room(id) + '/leave', {}), 200, 'A restricted member can leave the room');
    rejected(await join(id), /7 days/, 'A new native join cannot bypass the server age requirement');
  }
  await write(false, 0); // The equally young native owner can recover the server.
  for (const id of [server, voice]) checked(await join(id), 200, 'Disabling age requirements restores native admission');
  await write(true, 0);
  rejected(await encryptedAttempt(), /Verify your email/, 'The current unverified account is rejected using the real private verification bridge');
  rejected(await callWrite(callPayload), /Verify your email/, 'Email requirements also restrict native call admission');
  for (const id of [voice, server]) {
    checked(await native(alice, room(id) + '/leave', {}), 200, 'Email verification does not trap a member');
    rejected(await join(id), /Verify your email/, 'An unverified account cannot regain native membership');
  }
  await write(false, 0);
  for (const id of [server, voice]) {
    checked(await join(id), 200, 'Disabling verification restores native admission');
    checked(await native(admin, state(id, 'm.room.join_rules'), joinRules.get(id), 'PUT'), 200, 'Restore the fixture native join rule');
  }
  checked(await callWrite(callPayload), 200, 'Native call membership recovers after disabling requirements');
  checked(await callWrite({}), 200, 'Clean up the synthetic call membership without opening an SFU connection');
  checked(await native(admin, state(voice, 'm.room.power_levels'), callPowers, 'PUT'), 200, 'Restore the fixture native call powers');
  await alice.goto(origin + '/#room=' + encodeURIComponent(voice)); await ready(alice);
  const recovery = 'CI verified-policy recovery ' + randomBytes(12).toString('hex');
  await alice.getByRole('textbox', { name: 'Message CI AFK voice destination', exact: true }).fill(recovery);
  const response = await encryptedResponse(alice, () => alice.getByRole('button', { name: 'Send message', exact: true }).click());
  await encryptedEvent(alice, voice, response, recovery);
  assert.equal(checked(await matrixSmokeRequest(() => api(alice, '/api/auth/session')), 200, 'Inspect unchanged account verification').emailVerified, false);
  console.log('PASS: actual Synapse eligibility protects configuration and revisions, enforces native age and current unverified email for existing encrypted sends and fresh joins/call membership, permits owner recovery and teardown, and restores fresh SDK-encrypted posting after disable. No SFU or media capture was started.');
}
