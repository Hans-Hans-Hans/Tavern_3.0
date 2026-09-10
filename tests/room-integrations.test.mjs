import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

test('webhook controls require joined canonical parents, native power, role grants and no restriction', () => {
  const me = '@moderator:test';
  const event = (type, key, value) => ({ getContent: () => value, getStateKey: () => key, getSender: () => '@owner:test', type });
  function room(id, space = false) { const events = []; return { roomId: id, name: id, events, membership: 'join', isSpaceRoom: () => space, getMyMembership() { return this.membership; }, currentState: { getStateEvents: (type, key) => key === undefined ? events.filter(e => e.type === type) : events.find(e => e.type === type && e.getStateKey() === key) } }; }
  const channel = room('!channel:test'), server = room('!server:test', true), rooms = new Map([[channel.roomId, channel], [server.roomId, server]]);
  const client = { getUserId: () => me, getRoom: id => rooms.get(id) };
  const role = loadTs('../lib/roles.ts', { './api': { accountArtworkOwner: () => 0 }, './conference-publication': loadTs('../lib/conference-publication.ts', {}), './matrix': { getMatrixClient: () => client } });
  const policy = role.defaultRolePolicy('@owner:test'); policy.roles.push({ id: 'manager', name: 'Manager', position: 10, permissions: ['manage_webhooks'] }); policy.members[me] = ['manager'];
  server.events.push(event(role.rolesEvent, '', policy), event('m.space.child', channel.roomId, { via: ['test'] }));
  const powers = { users: { [me]: 50 }, state_default: 50 };
  channel.events.push(event('m.room.encryption', '', { algorithm: 'm.megolm.v1.aes-sha2' }), event('m.room.power_levels', '', powers), event('m.space.parent', server.roomId, { canonical: true, via: ['test'] }));
  const { canManageRoomWebhooks: allowed, roomWebhookLocations: locations } = loadTs('../lib/room-integrations.ts', { './member-state': loadTs('../lib/member-state.ts', {}), './api': { isManagedAccount: () => true }, './matrix': { getMatrixClient: () => client }, './roles': role, './channel-policy': { temporaryBanEvent: 'io.tavern.tempban' } });
  assert.equal(allowed(channel.roomId), true); assert.deepEqual(locations(server.roomId), [{ id: channel.roomId, name: channel.name }]); assert.equal(allowed(server.roomId), false);
  powers.users[me] = 0; assert.equal(allowed(channel.roomId), false); powers.users[me] = 50;
  policy.roles[1].permissions = []; assert.equal(allowed(channel.roomId), false); policy.roles[1].permissions = ['manage_webhooks'];
  server.membership = 'leave'; assert.equal(allowed(channel.roomId), false); server.membership = 'join';
  server.events.push(event('io.tavern.server.layout', '', { version: 1, categories: [{ id: 'private' }], channels: [{ id: channel.roomId, category: 'private' }] }));
  policy.categoryOverrides.private = { roles: { manager: { manage_webhooks: -1 } } }; assert.equal(allowed(channel.roomId), false);
  policy.overrides[channel.roomId] = { users: { [me]: { manage_webhooks: 1 } } }; assert.equal(allowed(channel.roomId), true);
  const restriction = event('io.tavern.tempban', me, { version: 1, until: Date.now() + 60000 }); server.events.push(restriction); assert.equal(allowed(channel.roomId), false); server.events.pop();
  channel.events.push(event('m.space.parent', '!unloaded:test', { canonical: true, via: ['test'] })); assert.equal(allowed(channel.roomId), false);
});
