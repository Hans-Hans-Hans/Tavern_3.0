import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const AFK = 'io.tavern.server.afk';
function fixture() {
  let authority = true, beforeRead = null, currentClient;
  const stateEvent = (type, state_key, content, event_id = '$' + type) => ({ type, state_key, content, event_id, getContent: () => content, getStateKey: () => state_key, getSender: () => '@owner:local' });
  const room = (roomId, name, space = false) => {
    const state = [stateEvent('m.room.create', '', { 'm.federate': false, ...(space ? { type: 'm.space' } : {}) })];
    return { roomId, name, state, membership: 'join', isSpaceRoom: () => space, getMyMembership() { return this.membership; }, currentState: { getStateEvents: (type, key) => key === undefined ? state.filter(event => event.type === type) : state.find(event => event.type === type && event.state_key === key) } };
  };
  const server = room('!server:local', 'Server', true), source = room('!source:local', 'Source'), voice = room('!voice:local', 'AFK');
  for (const target of [source, voice]) { server.state.push(stateEvent('m.space.child', target.roomId, { via: ['local'] })); target.state.push(stateEvent('m.space.parent', server.roomId, { via: ['local'], canonical: true })); }
  voice.state.push(stateEvent('m.room.encryption', '', { algorithm: 'm.megolm.v1.aes-sha2' }), stateEvent('io.tavern.channel', '', { kind: 'voice', version: 1, archived: false }));
  voice.state.push(stateEvent('m.room.power_levels', '', { users_default: 0, events: { 'org.matrix.msc3401.call.member': 0 } }));
  const saved = { version: 1, channelId: voice.roomId, timeoutSeconds: 300 };
  server.state.push(stateEvent(AFK, '', saved));
  const rooms = [server, source, voice], writes = [];
  const client = { getUserId: () => '@member:local', getRooms: () => rooms, getRoom: id => rooms.find(room => room.roomId === id), roomState: async id => { beforeRead?.(); return structuredClone(rooms.find(room => room.roomId === id).state.map(({ type, state_key, content, event_id }) => ({ type, state_key, content, event_id }))); }, sendStateEvent: async (...args) => writes.push(args) };
  currentClient = client;
  const matrix = { getMatrixClient: () => currentClient }, roles = loadTs('../lib/roles.ts', { './api': { accountArtworkOwner: () => 0 }, './conference-publication': loadTs('../lib/conference-publication.ts', {}), './matrix': matrix });
  const lib = loadTs('../lib/server-afk.ts', { './member-state': loadTs('../lib/member-state.ts', {}), './matrix': matrix, './roles': roles, './channel-administration': { canEditConversationState: () => authority, checkedConversationState: async () => { if (!authority) throw new Error('Permission changed'); return currentClient; } } });
  return { lib, server, source, voice, saved, writes, stateEvent, deny: () => { authority = false; }, beforeRead: fn => { beforeRead = fn; }, changeAccount: () => { currentClient = { ...client }; } };
}
test('only current reciprocal encrypted voice destinations are offered and AFK does not loop to itself', () => {
  const f = fixture(); assert.deepEqual(f.lib.afkDestinations(f.server.roomId), [{ id: f.voice.roomId, name: 'AFK' }]);
  assert.equal(f.lib.conferenceAfk(f.source.roomId).channelId, f.voice.roomId); assert.equal(f.lib.conferenceAfk(f.voice.roomId), null);
  f.voice.membership = 'leave'; assert.equal(f.lib.conferenceAfk(f.source.roomId), null); assert.deepEqual(f.lib.afkDestinations(f.server.roomId), []);
  f.voice.membership = 'join'; f.source.state.push(f.stateEvent('m.space.parent', '!second:local', { canonical: true, via: ['local'] })); assert.equal(f.lib.conferenceAfk(f.source.roomId), null);
});
test('AFK save sends a native state revision and refuses stale edits or authority lost during the read', async () => {
  const f = fixture(); await f.lib.saveServerAfk(f.server.roomId, { ...f.saved, timeoutSeconds: 600 }, f.saved);
  assert.equal(f.writes[0][2]['io.tavern.previous_event'], '$' + AFK);
  await assert.rejects(f.lib.saveServerAfk(f.server.roomId, f.saved, { ...f.saved, timeoutSeconds: 900 }), /changed/);
  f.beforeRead(f.deny); await assert.rejects(f.lib.saveServerAfk(f.server.roomId, f.saved, f.saved), /Permission/); assert.equal(f.writes.length, 1);
});
test('AFK save rejects account replacement and unavailable destination without writing', async () => {
  const f = fixture(); f.beforeRead(f.changeAccount); await assert.rejects(f.lib.saveServerAfk(f.server.roomId, f.saved, f.saved), /account/); assert.deepEqual(f.writes, []);
  const g = fixture(); g.voice.state.find(event => event.type === 'io.tavern.channel').content.archived = true;
  await assert.rejects(g.lib.saveServerAfk(g.server.roomId, g.saved, g.saved), /available/); assert.equal(g.lib.conferenceAfk(g.source.roomId), null);
});
test('malformed AFK configuration fails closed instead of inheriting a stale destination', () => {
  const f = fixture();
  for (const patch of [{ version: true }, { timeoutSeconds: true }, { timeoutSeconds: 0 }, { channelId: 'https://other' }, { channelId: '!bad\u007f' }, { movement: true }]) assert.equal(f.lib.parseServerAfk({ ...f.saved, ...patch }), null);
  f.server.state.find(event => event.type === AFK).content.timeoutSeconds = 42; assert.equal(f.lib.conferenceAfk(f.source.roomId), null);
});
test('AFK handoff suggestions enforce native call membership, custom channel/category deny, and active restrictions', () => {
  const f = fixture(), user = '@member:local';
  const policy = { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['join_calls'] }], members: {}, overrides: {}, categoryOverrides: {} };
  f.server.state.push(f.stateEvent('io.tavern.roles', '', policy));
  assert.ok(f.lib.conferenceAfk(f.source.roomId));
  const power = f.voice.state.find(event => event.type === 'm.room.power_levels').content;
  power.events['org.matrix.msc3401.call.member'] = 50; assert.equal(f.lib.conferenceAfk(f.source.roomId), null); power.events['org.matrix.msc3401.call.member'] = 0;
  policy.overrides[f.voice.roomId] = { roles: {}, users: { [user]: { join_calls: -1 } } }; assert.equal(f.lib.conferenceAfk(f.source.roomId), null); policy.overrides = {};
  policy.categoryOverrides.quiet = { roles: { everyone: { join_calls: -1 } }, users: {} };
  f.server.state.push(f.stateEvent('io.tavern.server.layout', '', { version: 1, categories: [{ id: 'quiet' }], channels: [{ id: f.voice.roomId, category: 'quiet' }] }));
  assert.equal(f.lib.conferenceAfk(f.source.roomId), null); policy.categoryOverrides = {};
  const timeout = f.stateEvent('io.tavern.timeout', user, { until: Date.now() + 60000 }); f.server.state.push(timeout); assert.equal(f.lib.conferenceAfk(f.source.roomId), null); timeout.content.until = 0;
  const ban = f.stateEvent('io.tavern.tempban', user, { version: 1, until: Date.now() + 60000 }); f.voice.state.push(ban); assert.equal(f.lib.conferenceAfk(f.source.roomId), null); ban.content.until = 0;
  assert.ok(f.lib.conferenceAfk(f.source.roomId));
});
