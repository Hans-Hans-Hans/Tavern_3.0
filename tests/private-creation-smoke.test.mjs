import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateCreationDenialProbe } from '../scripts/smoke-private-discussions.mjs';

const fixture = () => ({ visibility: 'private', preset: 'private_chat', invite: ['@cibob:chat.example.test'],
  creation_content: { type: 'io.tavern.private_thread', 'm.federate': false, 'io.tavern.private_thread': { version: 1, source_room_id: '!fixture:chat.example.test', source_event_id: '' } },
  initial_state: [{ type: 'io.tavern.private_thread.settings', state_key: '', content: { version: 1, title: 'CI private probe', archived: false, autoArchiveSeconds: 0, 'io.tavern.previous_event': null } },
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }, { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } }] });
const forbidden = { status: 403, data: { errcode: 'M_FORBIDDEN' } };
const limited = { status: 429, data: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 819 } };

test('negative private creation waits for the native cooldown and preserves the source while sending no invitations', async () => {
  const configuration = fixture(), requests = [], delays = [];
  const result = await privateCreationDenialProbe(async body => {
    requests.push(structuredClone(body)); body.invite = ['@unexpected:local'];
    return requests.length === 1 ? limited : forbidden;
  }, configuration, 'Require the actual permission denial', async delay => delays.push(delay));
  assert.equal(result, forbidden); assert.deepEqual(configuration, fixture());
  const expected = fixture(); delete expected.invite;
  assert.deepEqual(requests, [expected, expected]); assert.deepEqual(delays, [919]);
});

test('a successful unauthorized creation or ambiguous failure fails immediately without replay', async () => {
  for (const response of [{ status: 200, data: { room_id: '!unexpected:local' } }, { status: 500, data: {} }, { status: 403, data: { errcode: 'OTHER' } }]) {
    let calls = 0;
    await assert.rejects(privateCreationDenialProbe(async () => { calls++; return response; }, fixture(), 'Permission required', async () => assert.fail('Do not retry')));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(privateCreationDenialProbe(async () => { calls++; throw new Error('Unknown result'); }, fixture(), 'Permission required'), /Unknown result/);
  assert.equal(calls, 1);
});

test('persistent rate limiting remains a failure and other creation side effects are rejected before sending', async () => {
  let calls = 0;
  await assert.rejects(privateCreationDenialProbe(async () => { calls++; return limited; }, fixture(), 'Permission required', async () => {}));
  assert.equal(calls, 5);
  for (const extra of [{ invite_3pid: [] }, { room_alias_name: 'alias' }, { visibility: 'public' },
    { initial_state: [{ type: 'm.room.member', state_key: '', content: {} }] }]) {
    await assert.rejects(privateCreationDenialProbe(async () => assert.fail('Do not send'), { ...fixture(), ...extra }, 'Permission required'), /isolated private discussion/);
  }
});
