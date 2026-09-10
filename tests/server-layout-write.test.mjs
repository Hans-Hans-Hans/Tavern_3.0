import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
function setup() {
  const f = { user: '@owner:local', device: 'ONE', base: 'https://local', account: {}, writes: [], hook: null };
  const ev = (type, content, state_key = '', event_id = '$saved') => ({ type, content, state_key, event_id, sender: f.user });
  f.events = [ev('m.room.create', { type: 'm.space' }), ev('m.room.member', { membership: 'join' }, f.user),
    ev('m.room.power_levels', { users: { [f.user]: 100 } }), ev('m.space.child', { via: ['local'] }, '!one:local'),
    ev('io.tavern.server.layout', { version: 1, categories: [{ id: 'a', name: 'A', icon: '' }], channels: [{ id: '!one:local', category: '' }] })];
  f.room = { isSpaceRoom: () => true, getMyMembership: () => 'join', currentState: { maySendStateEvent: () => true,
    getStateEvents: (type, key) => key === undefined ? f.events.filter(e => e.type === type).map(e => ({ getContent: () => e.content, getStateKey: () => e.state_key })) : (() => { const e = f.events.find(e => e.type === type && e.state_key === key); return e && { getContent: () => e.content }; })() } };
  f.client = { getUserId: () => f.user, getDeviceId: () => f.device, getHomeserverUrl: () => f.base, getRoom: () => f.room,
    roomState: async () => { await f.hook?.(); return structuredClone(f.events); }, sendStateEvent: async (...args) => { f.writes.push(args); } };
  const matrix = { getMatrixClient: () => f.client }, api = { accountArtworkOwner: () => f.account };
  const roles = loadTs('../lib/roles.ts', { './matrix': matrix, './api': api, './conference-publication': loadTs('../lib/conference-publication.ts', {}) });
  f.model = loadTs('../lib/community.ts', { './matrix': matrix, './api': api, './roles': roles, './matrix-media': {}, './response-image': {}, './self-profile': {}, './server-nickname': {}, './profile-metadata-policy': {}, './server-branding': {} });
  f.old = f.model.readServerLayout('!server:local'); f.next = f.model.moveChannel(f.old, '!one:local', 'a'); return f;
}
test('layout save names current native revision and preserves channel IDs', async () => {
  const f = setup(); await f.model.saveServerLayout('!server:local', f.next, f.old);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0][2]['io.tavern.previous_event'], '$saved');
  assert.deepEqual(f.writes[0][2].channels, [{ id: '!one:local', category: 'a' }]);
});
test('stale layout edits reject concurrent category changes and channel additions', async () => {
  for (const change of [f => { f.events.at(-1).content.categories[0].name = 'Elsewhere'; }, f => { f.events.push({ type: 'm.space.child', state_key: '!new:local', content: { via: ['local'] } }); }]) {
    const f = setup(); f.hook = () => change(f);
    await assert.rejects(f.model.saveServerLayout('!server:local', f.next, f.old), /changed elsewhere/); assert.equal(f.writes.length, 0);
  }
});
test('layout writes retire on device, base, account or native room replacement', async () => {
  for (const change of [f => f.device = 'TWO', f => f.base = 'https://different', f => f.account = {}, f => f.room = { ...f.room }]) {
    const f = setup(); f.hook = () => change(f);
    await assert.rejects(f.model.saveServerLayout('!server:local', f.next, f.old), /changed/); assert.equal(f.writes.length, 0);
  }
});
test('fresh native power and malformed role policy deny despite cached permission', async () => {
  for (const change of [f => f.events[2].content.users[f.user] = 0, f => f.events.push({ type: 'io.tavern.roles', state_key: '', content: { version: 9 } })]) {
    const f = setup(); f.hook = () => change(f);
    await assert.rejects(f.model.saveServerLayout('!server:local', f.next, f.old), /permission/); assert.equal(f.writes.length, 0);
  }
});
