import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const server = '!server:local', room = '!channel:local', owner = '@owner:local', peer = '@peer:local', policyType = 'io.tavern.roles';
function fixture() {
  const f = { account: {}, actor: owner, ready: true, writes: [], beforeRead: null, beforeWrite: null, afterWrite: null };
  const matrix = { getMatrixClient: () => f.client }, api = { accountArtworkOwner: () => f.account, requestApi: async path => { assert.equal(path, '/channels/admission/capability'); return { version: 1, available: f.ready }; } };
  const roles = loadTs('../lib/roles.ts', { './matrix': matrix, './api': api, './conference-publication': loadTs('../lib/conference-publication.ts', {}) });
  const event = (type, content, state_key = '') => ({ type, state_key, content, sender: owner, event_id: '$' + type + state_key });
  f.states = {
    [server]: [event('m.room.create', { type: 'm.space', 'm.federate': false, room_version: '12' }), event('m.room.member', { membership: 'join' }, owner),
      event('m.space.child', { via: ['local'] }, room), event(policyType, roles.defaultRolePolicy(owner))],
    [room]: [event('m.room.create', { 'm.federate': false, room_version: '12' }), event('m.room.member', { membership: 'join' }, owner),
      event('m.space.parent', { via: ['local'], canonical: true }, server), event('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }), event('m.room.join_rules', { join_rule: 'invite' })],
  };
  const models = Object.fromEntries([server, room].map(id => [id, { isSpaceRoom: () => id === server, getMyMembership: () => 'join' }]));
  f.client = { getUserId: () => f.actor, getDeviceId: () => 'D', getRoom: id => models[id],
    roomState: async id => { const snapshot = structuredClone(f.states[id]); await f.beforeRead?.(id); return snapshot; },
    sendStateEvent: async (id, type, content, key) => {
      await f.beforeWrite?.(id, type);
      const previous = f.states[id].find(event => event.type === type && event.state_key === key);
      if (type === policyType) assert.equal(content['io.tavern.previous_event'], previous.event_id);
      f.writes.push({ id, type, content: structuredClone(content) });
      f.states[id] = f.states[id].filter(event => event !== previous).concat({ ...event(type, structuredClone(content), key), event_id: '$saved' + f.writes.length });
      await f.afterWrite?.(id, type);
    },
  };
  f.value = (id, type) => f.states[id].find(event => event.type === type).content;
  f.model = loadTs('../lib/channel-admission.ts', { './api': api, './matrix': matrix, './roles': roles });
  f.desired = { roleIds: ['everyone'], userIds: [peer] };
  return f;
}

test('audience enables before restricted native joins, preserves roles, and never joins or invites anyone', async () => {
  const f = fixture(), original = structuredClone(f.value(server, policyType));
  await f.model.saveChannelAudience(server, room, f.desired, null);
  assert.deepEqual(f.writes.map(row => row.type), [policyType, 'm.room.join_rules']);
  assert.deepEqual(f.value(server, policyType).roles, original.roles);
  assert.deepEqual(f.value(server, policyType).channelAdmissions[room], f.desired);
  assert.deepEqual(f.value(room, 'm.room.join_rules'), { join_rule: 'restricted', allow: [{ type: 'm.room_membership', room_id: server }] });
});

test('removing an audience restores invitation-only joins before changing its policy', async () => {
  const f = fixture(); await f.model.saveChannelAudience(server, room, f.desired, null); f.writes = [];
  await f.model.saveChannelAudience(server, room, null, f.desired);
  assert.deepEqual(f.writes.map(row => row.type), ['m.room.join_rules', policyType]);
  assert.deepEqual(f.value(server, policyType).channelAdmissions, {});
  assert.equal(f.value(server, policyType).channelAdmissionVersion, 1);
});

test('a lost native acknowledgement can finish the same audience without replaying its policy write', async () => {
  const f = fixture(); let failed = false;
  f.afterWrite = async (_id, type) => { if (type === policyType && !failed) { failed = true; throw new Error('Response lost'); } };
  await assert.rejects(f.model.saveChannelAudience(server, room, f.desired, null), /Response lost/);
  assert.equal(f.value(room, 'm.room.join_rules').join_rule, 'invite');
  await f.model.saveChannelAudience(server, room, f.desired, null);
  assert.equal(f.writes.filter(row => row.type === policyType).length, 1);
  assert.equal(f.value(room, 'm.room.join_rules').join_rule, 'restricted');
});

test('missing live enforcement, unknown roles, stale audiences and account retirement reject before writes', async () => {
  for (const change of [
    f => { f.ready = false; },
    f => { f.desired.roleIds = ['deleted']; },
    f => { Object.assign(f.value(server, policyType), { channelAdmissionVersion: 1, channelAdmissions: { [room]: { roleIds: [], userIds: [] } } }); },
    f => { f.beforeRead = async () => { f.account = {}; }; },
    f => { f.states[server].find(event => event.type === 'm.room.create').sender = peer; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.model.saveChannelAudience(server, room, f.desired, null));
    assert.deepEqual(f.writes, []);
  }
});

test('native role authority lost on a legacy server cannot close or change its channel', async () => {
  const f = fixture(); f.value(server, 'm.room.create').room_version = '11';
  f.states[server].push({ type: 'm.room.power_levels', state_key: '', content: { users: { [owner]: 0 }, state_default: 50 } });
  await assert.rejects(f.model.saveChannelAudience(server, room, f.desired, null), /native channel authority/);
  assert.deepEqual(f.writes, []);
});
