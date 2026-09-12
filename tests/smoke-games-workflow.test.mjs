import test from 'node:test';
import assert from 'node:assert/strict';
import { gamesWorkflowSmoke } from '../scripts/smoke-games-workflow.mjs';
import { proveVoiceConferenceRoom } from '../scripts/smoke-conference.mjs';
test('Games acceptance refuses unscoped invocation before UI or native access', async () => {
  let touched = false;
  await assert.rejects(gamesWorkflowSmoke({ origin: 'https://outside.invalid', api: async () => { touched = true; } }), /exact isolated CI/);
  assert.equal(touched, false);
});
test('voice acceptance requires a marked parent, exact audience and native two-user room', () => {
  const actor = '@cialice:chat.example.test', peer = '@cibob:chat.example.test', roomId = '!voice:chat.example.test', serverId = '!games:chat.example.test', runId = 'a'.repeat(24);
  const ev = (type, content, state_key = '') => ({ type, content, state_key, sender: actor });
  const fixture = { roomId, serverId, runId };
  const parent = [ev('m.room.create', { type: 'm.space', 'm.federate': false, room_version: '10', 'io.tavern.ci_games_workflow': runId }),
    ev('m.room.name', { name: 'CI Games ' + runId }), ev('m.room.member', { membership: 'join' }, actor), ev('m.space.child', { via: ['chat.example.test'] }, roomId),
    ev('io.tavern.roles', { owner: actor, channelAdmissionVersion: 1, channelAdmissions: { [roomId]: { roleIds: ['gaming'], userIds: [] } }, members: { [peer]: ['gaming'] } })];
  const child = [ev('m.room.create', { 'm.federate': false, room_version: '10' }), ev('m.room.name', { name: 'Gaming Voice' }), ev('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }),
    ev('io.tavern.channel', { kind: 'voice' }), ev('m.room.join_rules', { join_rule: 'restricted' }), ev('m.room.power_levels', { events: { 'org.matrix.msc3401.call.member': 0 } }),
    ev('m.space.parent', { canonical: true, via: ['chat.example.test'] }, serverId), ev('m.room.member', { membership: 'join' }, actor), ev('m.room.member', { membership: 'join' }, peer)];
  proveVoiceConferenceRoom(roomId, child, fixture, parent);
  for (const change of [p => p[0].content['io.tavern.ci_games_workflow'] = 'b'.repeat(24), p => p[0].sender = peer, p => p[4].content.channelAdmissions[roomId].roleIds = ['everyone']]) {
    const changed = structuredClone(parent); change(changed); assert.throws(() => proveVoiceConferenceRoom(roomId, child, fixture, changed));
  }
  assert.throws(() => proveVoiceConferenceRoom(roomId, [...child, child[0]], fixture, parent));
  assert.throws(() => proveVoiceConferenceRoom(roomId, [...child, ev('m.room.member', { membership: 'join' }, '@other:chat.example.test')], fixture, parent));
});
