import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
let client;
const matrix = { getMatrixClient: () => client };
const roles = loadTs('../lib/roles.ts', { './matrix': matrix });
const nicknames = loadTs('../lib/server-nickname.ts', { './matrix': matrix, './roles': roles });
const community = loadTs('../lib/community.ts', { './matrix': matrix, './roles': roles, './server-nickname': nicknames, './matrix-media': loadTs('../lib/matrix-media.ts', {}), './response-image': loadTs('../lib/response-image.ts', {}), './profile-metadata-policy': { visibleProfileMetadata: profile => profile, checkProfileMetadataPublication: async (roomId, profile, client) => ({ client, actor: client.getUserId(), membership: await client.getStateEvent(roomId, 'm.room.member', client.getUserId()), profile }) }, './server-branding': {}, './self-profile': loadTs('../lib/self-profile.ts', { 'matrix-js-sdk/lib/http-api/method': { Method: { Get: 'GET' } } }) });
const type = nicknames.serverNicknameEvent;
function fixture() {
  const event = (type, state_key, content, sender = '@owner:test', event_id = '$' + type + state_key) => ({ type, state_key, content, sender, event_id });
  const policy = { version: 1, owner: '@owner:test', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: [] }, { id: 'mod', name: 'Moderator', position: 50, permissions: ['manage_nicknames'] }], members: { '@mod:test': ['mod'] }, overrides: {}, categoryOverrides: {} };
  const server = [event('m.room.create', '', { type: 'm.space', 'm.federate': false }), event('m.room.power_levels', '', { users: { '@owner:test': 100, '@mod:test': 50 }, users_default: 0 }), event('io.tavern.roles', '', policy),
    event('m.room.member', '@mod:test', { membership: 'join' }), event('m.room.member', '@target:test', { membership: 'join', displayname: 'Chosen server name', avatar_url: 'mxc://media/avatar', 'io.tavern.profile': { serverOverride: '!server:test', bio: 'Private profile text' } }), event('m.space.child', '!channel:test', { via: ['test'] })];
  const channel = [event('m.room.member', '@target:test', { membership: 'join', displayname: 'Global chosen name' }), event('m.space.parent', '!server:test', { canonical: true, via: ['test'] })];
  const dm = [event('m.room.member', '@target:test', { membership: 'join', displayname: 'Global chosen name' })];
  const all = { '!server:test': server, '!channel:test': channel, '!dm:test': dm }, writes = [];
  const wrap = event => event && ({ getContent: () => event.content, getId: () => event.event_id, getSender: () => event.sender, getStateKey: () => event.state_key });
  client = { getUserId: () => '@mod:test', getUser: userId => ({ userId, displayName: 'Global chosen name' }), getAccountData: () => null,
    getRoom: id => all[id] && ({ roomId: id, isSpaceRoom: () => id === '!server:test', getMyMembership: () => 'join', getMember: user => ({ name: all[id].find(e => e.type === 'm.room.member' && e.state_key === user)?.content.displayname }), currentState: { getStateEvents: (type, key) => key === undefined ? all[id].filter(e => e.type === type).map(wrap) : wrap(all[id].find(e => e.type === type && e.state_key === key)) } }),
    roomState: async id => structuredClone(all[id]), sendStateEvent: async (room, type, content, key) => { writes.push({ room, type, content, key }); const existing = all[room].findIndex(e => e.type === type && e.state_key === key), next = event(type, key, content, '@mod:test', '$saved' + writes.length); if (existing < 0) all[room].push(next); else all[room][existing] = next; return { event_id: next.event_id }; },
  };
  return { all, server, channel, policy, writes, event };
}
test('setting and clearing server nickname preserve the member profile and global identity', async () => {
  const f = fixture(), membership = structuredClone(f.server.find(e => e.type === 'm.room.member' && e.state_key === '@target:test'));
  const saved = await nicknames.saveServerNickname('!server:test', '@target:test', '  Managed nickname  ', null);
  assert.equal(saved.name, 'Managed nickname'); assert.equal(f.writes[0].type, type); assert.equal(f.writes[0].key, '@target:test'); assert.equal(f.writes[0].content['io.tavern.previous_event'], null);
  const profile = community.readMemberProfile('!channel:test', '@target:test', '!server:test'); assert.equal(profile.name, 'Managed nickname'); assert.equal(profile.bio, 'Private profile text'); assert.equal(profile.avatar, 'mxc://media/avatar');
  assert.equal(community.readMemberProfile('!dm:test', '@target:test').name, 'Global chosen name'); assert.equal(nicknames.serverNicknameForRoom('!dm:test', '@target:test', '!server:test'), null);
  await nicknames.saveServerNickname('!server:test', '@target:test', null, saved.eventId);
  assert.equal(community.readMemberProfile('!channel:test', '@target:test', '!server:test').name, 'Chosen server name');
  assert.deepEqual(f.server.find(e => e.type === 'm.room.member' && e.state_key === '@target:test'), membership); assert.ok(f.writes.every(write => write.type === type));
});
test('stale nickname revision rejects save without silently overwriting another moderator', async () => {
  const f = fixture(); f.server.push(f.event(type, '@target:test', { version: 1, name: 'Other moderator' }, '@owner:test', '$other'));
  await assert.rejects(nicknames.saveServerNickname('!server:test', '@target:test', 'Preserve my draft', null), /changed elsewhere/); assert.equal(f.writes.length, 0);
  assert.equal((await nicknames.loadServerNickname('!server:test', '@target:test')).eventId, '$other');
});
test('fresh native promotion, role revocation and account switch reject before any state write', async () => {
  for (const change of ['power', 'role', 'account']) {
    const f = fixture(), original = client.roomState;
    client.roomState = async id => { const state = await original(id); if (change === 'power') state.find(e => e.type === 'm.room.power_levels').content.users['@target:test'] = 50; if (change === 'role') state.find(e => e.type === 'io.tavern.roles').content.roles[1].permissions = []; if (change === 'account') client = { ...client }; return state; };
    await assert.rejects(nicknames.saveServerNickname('!server:test', '@target:test', 'Denied', null), /authority changed/); assert.equal(f.writes.length, 0);
  }
});
test('self, native peers and invalid names cannot be submitted and server-only grants cannot be overridden', async () => {
  const f = fixture(); assert.equal(nicknames.canManageServerNickname('!server:test', '@mod:test'), false);
  for (const value of ['', 'line\nbreak', 'x'.repeat(61)]) await assert.rejects(nicknames.saveServerNickname('!server:test', '@target:test', value, null), /1–60/);
  f.policy.categoryOverrides.private = { users: { '@mod:test': { manage_nicknames: 1 } } }; assert.equal(roles.parseRolePolicy(f.policy), null); assert.equal(nicknames.canManageServerNickname('!server:test', '@target:test'), false); assert.equal(f.writes.length, 0);
});
