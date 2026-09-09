import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

function fixture(managed = true) {
  const make = (roomId, sender = '@owner:test') => {
    const values = [], room = { roomId, name: 'Room', values, currentState: { getStateEvents: (type, key) => key === undefined ? values.filter(event => event.type === type) : values.find(event => event.type === type && event.state_key === key) || null }, getMyMembership: () => room.getMember(f.actor)?.membership, getMember: id => { const value = values.find(event => event.type === 'm.room.member' && event.state_key === id)?.content; return value ? { userId: id, name: id, membership: value.membership } : null; } };
    room.put = (type, value, key = '', who = sender) => { const previous = values.findIndex(event => event.type === type && event.state_key === key); const event = { type, state_key: key, content: value, sender: who, getContent: () => event.content, getStateKey: () => key, getSender: () => who }; if (previous >= 0) values.splice(previous, 1, event); else values.push(event); return event; };
    room.put('m.room.create', { room_version: '11', ...(roomId === '!server:test' ? { type: 'm.space' } : {}) });
    room.put('m.room.power_levels', { users: { '@owner:test': 100, '@moderator:test': 50 }, events: {}, users_default: 0 });
    for (const user of ['@owner:test', '@moderator:test', '@member:test', '@peer:test']) room.put('m.room.member', { membership: 'join' }, user);
    return room;
  };
  const f = { actor: '@moderator:test', writes: [], rooms: {}, beforeRead: null, afterWrite: null, reads: [] };
  f.room = make('!room:test'); f.server = make('!server:test'); f.rooms = { '!room:test': f.room, '!server:test': f.server };
  f.client = { getUserId: () => f.actor, getRoom: id => f.rooms[id], roomState: async id => { f.reads.push(id); if (f.beforeRead) await f.beforeRead(id); return f.rooms[id].values.map(({ type, state_key, content, sender }) => ({ type, state_key, content: structuredClone(content), sender })); }, sendStateEvent: async (...args) => { f.writes.push(args); if (f.afterWrite) await f.afterWrite(args); }, kick: async (...args) => f.writes.push(['kick', ...args]), ban: async (...args) => f.writes.push(['ban', ...args]), unban: async (...args) => f.writes.push(['unban', ...args]) };
  f.active = f.client;
  const matrix = { getMatrixClient: () => f.active };
  f.roles = loadTs('../lib/roles.ts', { './matrix': matrix });
  f.policy = { ...f.roles.defaultRolePolicy('@owner:test'), roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: [] }, { id: 'moderator', name: 'Moderator', position: 10, permissions: ['manage_channels', 'kick', 'ban'] }], members: { '@moderator:test': ['moderator'], '@peer:test': ['moderator'] } };
  if (managed) { f.server.put('io.tavern.roles', f.policy); f.server.put('m.space.child', { via: ['test'] }, '!room:test'); f.room.put('m.space.parent', { via: ['test'], canonical: true }, '!server:test'); }
  f.api = loadTs('../lib/channel-administration.ts', { './matrix': matrix, './roles': f.roles });
  return f;
}

test('custom role manager can edit channel details but native power remains an owner action', () => {
  const f = fixture();
  assert.equal(f.api.canEditConversationDetails('!room:test'), true);
  assert.equal(f.api.canEditNativePermissions('!room:test'), false);
  assert.equal(f.api.canAdministerMember('!room:test', '@member:test', 'moderator'), false);
  assert.equal(f.api.canAdministerMember('!room:test', '@member:test', 'kick'), true);
  assert.equal(f.api.canAdministerMember('!room:test', '@peer:test', 'kick'), false);
  assert.equal(f.api.canAdministerMember('!room:test', '@owner:test', 'kick'), false);
  f.actor = '@owner:test'; assert.equal(f.api.canEditNativePermissions('!room:test'), true);
});

test('category and channel restrictions apply and invalid or unknown policy fails closed', () => {
  const f = fixture();
  f.server.put('io.tavern.server.layout', { version: 1, categories: [{ id: 'private' }], channels: [{ id: '!room:test', category: 'private' }] });
  f.policy.categoryOverrides = { private: { roles: { moderator: { kick: -1, manage_channels: -1 } }, users: {} } };
  assert.equal(f.api.canAdministerMember('!room:test', '@member:test', 'kick'), false);
  assert.equal(f.api.canEditConversationDetails('!room:test'), false);
  f.policy.overrides = { '!room:test': { roles: {}, users: { '@moderator:test': { kick: 1 } } } };
  assert.equal(f.api.canAdministerMember('!room:test', '@member:test', 'kick'), true);
  f.policy.version = 9; assert.equal(f.api.canAdministerMember('!room:test', '@member:test', 'kick'), false);
  delete f.rooms['!server:test']; assert.equal(f.api.canEditNativePermissions('!room:test'), false);
});

test('unban checks both native thresholds and actions match the target membership', () => {
  const f = fixture(false), powers = f.room.currentState.getStateEvents('m.room.power_levels', '').content;
  f.room.put('m.room.member', { membership: 'ban' }, '@member:test'); powers.ban = 50; powers.kick = 100;
  assert.equal(f.api.canAdministerMember('!room:test', '@member:test', 'unban'), false);
  assert.equal(f.api.canAdministerMember('!room:test', '@member:test', 'kick'), false);
  assert.equal(f.api.canAdministerMember('!room:test', '@member:test', 'ban'), false);
  powers.kick = 50; assert.equal(f.api.canAdministerMember('!room:test', '@member:test', 'unban'), true);
  assert.equal(f.api.canAdministerMember('!room:test', '@member:test', 'unexpected'), false);
});

test('native power updates preserve other members and the creator fallback', async () => {
  const f = fixture(false); f.actor = '@owner:test';
  await f.api.administerMember('!room:test', '@member:test', 'moderator', '', 0);
  assert.deepEqual(f.writes[0][2].users, { '@owner:test': 100, '@moderator:test': 50, '@member:test': 50 });
  f.writes.length = 0; f.room.values.splice(f.room.values.findIndex(event => event.type === 'm.room.power_levels'), 1);
  assert.equal(f.api.conversationMemberLevel('!room:test', '@owner:test'), 100);
  await f.api.administerMember('!room:test', '@member:test', 'moderator', '', 0);
  assert.deepEqual(f.writes[0][2].users, { '@owner:test': 100, '@member:test': 50 });
});

test('room version 12 creators retain native authority without numeric entries', () => {
  const f = fixture(false); f.actor = '@owner:test';
  f.room.put('m.room.create', { room_version: '12', additional_creators: ['@peer:test'] });
  f.room.currentState.getStateEvents('m.room.power_levels', '').content.users = { '@moderator:test': 50 };
  assert.equal(f.api.conversationMemberLevel('!room:test', '@owner:test'), Infinity);
  assert.equal(f.api.conversationMemberLevel('!room:test', '@peer:test'), Infinity);
  assert.equal(f.api.canAdministerMember('!room:test', '@peer:test', 'moderator'), false);
  assert.equal(f.api.canAdministerMember('!room:test', '@member:test', 'moderator'), true);
});

test('stale remote policy and changed sign-in abort before native writes', async () => {
  const f = fixture(); f.beforeRead = async id => { if (id === '!server:test') f.policy.roles[1].permissions = []; };
  await assert.rejects(f.api.administerMember('!room:test', '@member:test', 'kick', '', 0), /changed while syncing/);
  assert.deepEqual(f.writes, []);
  const other = fixture(); other.beforeRead = async () => { other.active = { ...other.client }; };
  await assert.rejects(other.api.administerMember('!room:test', '@member:test', 'kick', '', 0), /account or room permissions changed/);
  assert.deepEqual(other.writes, []);
});

test('a target promoted while confirmation was open must be reviewed again', async () => {
  const f = fixture(false); f.actor = '@owner:test';
  f.room.currentState.getStateEvents('m.room.power_levels', '').content.users['@member:test'] = 10;
  await assert.rejects(f.api.administerMember('!room:test', '@member:test', 'moderator', '', 0), /member’s permissions changed/);
  assert.deepEqual(f.writes, []);
});

test('details report partial completion and stop topic writes after permission revocation', async () => {
  const f = fixture(); f.afterWrite = async () => { f.policy.roles[1].permissions = []; };
  await assert.rejects(f.api.saveConversationDetails('!room:test', 'New name', 'New topic'), /Name saved, but the topic/);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0][1], 'm.room.name');
});

test('native permission editing merges only selected values and preserves privileged unrelated settings', async () => {
  const f = fixture(false), powers = f.room.currentState.getStateEvents('m.room.power_levels', '').content;
  powers.events = { 'm.room.power_levels': 50, 'm.room.pinned_events': 100, 'custom.event': 100 };
  powers.notifications = { room: 100 };
  await f.api.saveNativePermissions('!room:test', { post: 50, invite: 0, pin: 100, conference: 50 });
  assert.equal(f.writes[0][2].events['custom.event'], 100); assert.equal(f.writes[0][2].events['m.room.pinned_events'], 100);
  assert.deepEqual(f.writes[0][2].notifications, { room: 100 });
  assert.equal(f.writes[0][2].events['m.room.message'], 50); assert.equal(f.writes[0][2].events['m.room.encrypted'], 50);
  await assert.rejects(f.api.saveNativePermissions('!room:test', { post: 50, invite: 0, pin: 0, conference: 50 }), /above your native/);
  assert.equal(f.writes.length, 1);
});
