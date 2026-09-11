import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const serverId = '!server:local', actor = '@owner:local', peer = '@peer:local';
const ev = (type, content, state_key = '', sender = actor) => ({ type, state_key, sender, content, event_id: '$'+type+state_key });
function setup() {
  const f = { actor, account: {}, writes: [], creates: [], reads: [], beforeRead: null, beforeWrite: null, beforeCreate: null, config: { serverRolePolicy: true, callsEnabled: true } };
  const matrix = { getMatrixClient: () => f.client }, api = { accountArtworkOwner: () => f.account };
  const roles = loadTs('../lib/roles.ts', { './matrix': matrix, './api': api, './conference-publication': loadTs('../lib/conference-publication.ts', {}) });
  const channels = loadTs('../lib/channel-policy.ts', { './matrix': matrix, './roles': roles, './member-state': loadTs('../lib/member-state.ts', {}) });
  const community = loadTs('../lib/community.ts', { './api': { accountArtworkOwner: () => null }, './matrix': matrix, './roles': roles, './server-nickname': {}, './matrix-media': {}, './response-image': {}, './profile-metadata-policy': {}, './server-branding': {}, './self-profile': {} });
  f.roles = roles;
  f.states = { [serverId]: [ev('m.room.create', { type: 'm.space', room_version: '12', 'm.federate': false }),
    ev('m.room.member', { membership: 'join' }, actor), ev('m.room.member', { membership: 'join' }, peer),
    ev('m.room.power_levels', { events: {}, users: {}, users_default: 0, state_default: 50 }),
    ev('io.tavern.roles', roles.defaultRolePolicy(actor)), ev('io.tavern.server.layout', { version: 1, categories: [{ id: 'projects', name: 'Projects', icon: '' }], channels: [] }),
  ] };
  f.client = { getUserId: () => f.actor, getDeviceId: () => 'DEVICE', getHomeserverUrl: () => 'https://local/api/matrix',
    getRoom: id => ({ roomId: id, currentState: { getStateEvents: (type, key) => key === undefined ? (f.states[id] || []).filter(value => value.type === type) : f.states[id]?.find(value => value.type === type && value.state_key === key) } }),
    roomState: async id => { f.reads.push(id); const snapshot = structuredClone(f.states[id]); if (f.beforeRead) await f.beforeRead(id); return snapshot; },
    createRoom: async config => {
      f.creates.push(structuredClone(config)); if (f.beforeCreate) await f.beforeCreate();
      const id = '!created-' + f.creates.length + ':local';
      f.states[id] = [ev('m.room.create', { ...config.creation_content, room_version: '12' }, '', f.actor), ev('m.room.member', { membership: 'join' }, f.actor),
        ev('m.room.power_levels', { users: {}, events: config.power_level_content_override.events }), ev('m.room.name', { name: config.name }), ...config.initial_state.map(value => ({ ...structuredClone(value), sender: f.actor }))];
      return { room_id: id };
    },
    sendStateEvent: async (id, type, content, key) => {
      if (f.beforeWrite) await f.beforeWrite({ id, type, content, key });
      f.writes.push({ id, type, content: structuredClone(content), key });
      f.states[id] = f.states[id].filter(value => value.type !== type || value.state_key !== key); f.states[id].push(ev(type, structuredClone(content), key));
    },
    joinRoom: async id => { f.writes.push({ type: 'join', id }); },
    invite: async (id, user) => {
      if (f.beforeWrite) await f.beforeWrite({ id, type: 'invite', user });
      f.writes.push({ id, type: 'invite', user }); f.states[id].push(ev('m.room.member', { membership: 'invite' }, user));
    },
  };
  f.model = loadTs('../lib/channel-creation.ts', { 'matrix-js-sdk': { Preset: { PrivateChat: 'private_chat' }, Visibility: { Private: 'private' } }, './matrix': matrix, './api': api,
    './instance': { readInstanceConfig: async () => ({ ...f.config }) }, './channel-policy': channels, './community': community, './roles': roles });
  f.draft = { name: 'Plans', description: 'Discussion purpose', kind: 'text', slowModeSeconds: 0, serverId, categoryId: '', members: [], icon: '💬' };
  return f;
}

test('every supported channel type persists real initial behavior with encrypted joined history and native call powers', async () => {
  for (const kind of ['text', 'voice', 'video', 'forum', 'announcement', 'rules', 'media', 'read-only']) {
    const f = setup(), result = await f.model.createTypedChannel({ ...f.draft, kind, slowModeSeconds: 30, categoryId: 'projects', members: [peer] });
    assert.deepEqual(result.errors, []); assert.equal(result.linked, true); assert.equal(result.categoryApplied, true); assert.deepEqual(result.invited, [peer]);
    assert.equal(f.creates.length, 1); const config = f.creates[0];
    assert.equal(config.preset, 'private_chat'); assert.equal(config.visibility, 'private'); assert.equal(config.creation_content['m.federate'], false);
    assert.equal(config.invite, undefined, 'Invitations must follow successful known-room creation/linking.');
    const state = type => config.initial_state.find(value => value.type === type).content;
    assert.deepEqual(state('m.room.encryption'), { algorithm: 'm.megolm.v1.aes-sha2' }); assert.deepEqual(state('m.room.history_visibility'), { history_visibility: 'joined' });
    assert.deepEqual(state('io.tavern.channel'), { version: 1, kind, slowModeSeconds: 30, archived: false, icon: '💬' });
    assert.equal(config.power_level_content_override.events['org.matrix.msc3401.call.member'], 0);
    assert.equal(config.power_level_content_override.events['m.room.encrypted'], ['announcement', 'rules', 'read-only'].includes(kind) ? 50 : undefined);
    assert.deepEqual(f.writes.map(write => write.type), ['join', 'm.space.child', 'io.tavern.server.layout', 'invite']);
  }
});

test('permission, category and membership rejection occur before room creation', async () => {
  for (const mutate of [
    f => { f.states[serverId].find(value => value.type === 'm.room.member' && value.state_key === actor).content.membership = 'leave'; },
    f => { f.states[serverId].find(value => value.type === 'io.tavern.roles').content.version = 9; },
    f => { f.states[serverId].find(value => value.type === 'm.room.create').content['m.federate'] = true; },
    f => { f.draft.categoryId = 'removed'; },
    f => { f.draft.members = ['@stranger:local']; },
  ]) {
    const f = setup(); mutate(f); await assert.rejects(f.model.createTypedChannel(f.draft)); assert.equal(f.creates.length, 0); assert.equal(f.writes.length, 0);
  }
  const f = setup(); f.actor = '@moderator:local';
  f.states[serverId].push(ev('m.room.member', { membership: 'join' }, f.actor)); f.states[serverId].find(value => value.type === 'm.room.power_levels').content.users[f.actor] = 50;
  await assert.rejects(f.model.createTypedChannel(f.draft), /server role/); assert.equal(f.creates.length, 0);
});

test('native child managers retain granular grants and category-boundary restrictions', async () => {
  const f = setup(); f.actor = '@moderator:local';
  f.states[serverId].push(ev('m.room.member', { membership: 'join' }, f.actor)); f.states[serverId].find(value => value.type === 'm.room.power_levels').content.users[f.actor] = 50;
  const policy = f.states[serverId].find(value => value.type === 'io.tavern.roles').content;
  policy.roles.push({ id: 'mod', name: 'Moderator', position: 10, permissions: ['manage_channels'] }); policy.members[f.actor] = ['mod'];
  policy.categoryOverrides = { projects: { users: { [peer]: { send_messages: -1 } }, roles: {} } };
  await assert.rejects(f.model.createTypedChannel({ ...f.draft, categoryId: 'projects' }), /category permission boundaries/);
  assert.equal(f.creates.length, 0);
  const result = await f.model.createTypedChannel(f.draft); assert.equal(result.linked, true); assert.equal(f.creates.length, 1);
});

test('ancestor role denial and authority drift during copied native reads prevent creation', async () => {
  const f = setup(), parent = '!ancestor:local';
  f.states[parent] = structuredClone(f.states[serverId]); f.states[parent].find(value => value.type === 'm.room.create').sender = peer;
  f.states[parent].find(value => value.type === 'io.tavern.roles').content = f.roles.defaultRolePolicy(peer);
  f.states[serverId].push(ev('m.space.parent', { canonical: true, via: ['local'] }, parent)); f.states[parent].push(ev('m.space.child', { via: ['local'] }, serverId));
  await assert.rejects(f.model.createTypedChannel(f.draft), /server role/); assert.equal(f.creates.length, 0);
  const changed = setup(); let once = true;
  changed.beforeRead = () => { if (once) { once = false; changed.states[serverId].find(value => value.type === 'm.room.member' && value.state_key === actor).content.membership = 'leave'; } };
  await assert.rejects(changed.model.createTypedChannel(changed.draft), /changed while checking/); assert.equal(changed.creates.length, 0);
});

test('partial placement retains the created room and retries without creating or inviting twice', async () => {
  const f = setup(); let fail = true;
  f.beforeWrite = ({ type }) => { if (type === 'io.tavern.server.layout' && fail) { fail = false; throw new Error('Layout failed'); } };
  const result = await f.model.createTypedChannel({ ...f.draft, categoryId: 'projects', members: [peer] });
  assert.equal(result.linked, true); assert.equal(result.categoryApplied, false); assert.deepEqual(result.invited, []); assert.deepEqual(result.errors, ['Layout failed']);
  await f.model.finishChannelCreation(result); assert.deepEqual(result.errors, []); assert.equal(f.creates.length, 1);
  assert.equal(f.writes.filter(value => value.type === 'm.space.child').length, 1); assert.equal(f.writes.filter(value => value.type === 'invite').length, 1);
  await f.model.finishChannelCreation(result); assert.equal(f.writes.filter(value => value.type === 'invite').length, 1);
});

test('ambiguous invitation acknowledgement is resolved from native membership without replay', async () => {
  const f = setup(); let once = true;
  f.beforeWrite = ({ id, type, user }) => { if (type === 'invite' && once) { once = false; f.states[id].push(ev('m.room.member', { membership: 'invite' }, user)); throw new Error('Connection lost after invite'); } };
  const result = await f.model.createTypedChannel({ ...f.draft, members: [peer] }); assert.deepEqual(result.pendingMembers, [peer]);
  await f.model.finishChannelCreation(result); assert.deepEqual(result.pendingMembers, []); assert.deepEqual(result.invited, [peer]);
  assert.equal(f.writes.filter(value => value.type === 'invite').length, 0); assert.equal(f.creates.length, 1);
});

test('account generation retirement fences creation responses and retained retry receipts', async () => {
  const f = setup(); f.beforeCreate = () => { f.account = {}; };
  await assert.rejects(f.model.createTypedChannel(f.draft), /account changed/); assert.equal(f.creates.length, 1); assert.equal(f.writes.length, 0);
  const retry = setup(); retry.beforeWrite = () => { throw new Error('Temporary failure'); };
  const result = await retry.model.createTypedChannel(retry.draft); retry.account = {};
  await assert.rejects(retry.model.finishChannelCreation(result), /account changed/); assert.equal(retry.creates.length, 1);
});

test('changed created-room privacy or parent binding stops invitations without recreating a room', async () => {
  for (const change of ['history', 'parent']) {
    const f = setup(); let once = true;
    f.beforeWrite = ({ id, type }) => {
      if (type === 'm.space.child' && once) {
        once = false; const values = f.states['!created-1:local'];
        if (change === 'history') values.find(value => value.type === 'm.room.history_visibility').content.history_visibility = 'shared';
        else values.find(value => value.type === 'm.space.parent').content = {};
      }
    };
    const result = await f.model.createTypedChannel({ ...f.draft, members: [peer] });
    assert.match(result.errors[0], /server relationship changed/); assert.deepEqual(result.pendingMembers, [peer]);
    assert.equal(f.writes.some(value => value.type === 'invite'), false); assert.equal(f.creates.length, 1);
  }
});

test('unavailable policy supports unchanged basic text but rejects unsupported typed/slow-mode promises', async () => {
  const f = setup(); f.config.serverRolePolicy = false;
  await assert.rejects(f.model.createTypedChannel({ ...f.draft, kind: 'voice' }), /unavailable/);
  await assert.rejects(f.model.createTypedChannel({ ...f.draft, slowModeSeconds: 5 }), /unavailable/); assert.equal(f.creates.length, 0);
  const result = await f.model.createTypedChannel({ ...f.draft, serverId: undefined });
  assert.deepEqual(result.errors, []); assert.equal(f.creates[0].initial_state.some(value => value.type === 'io.tavern.channel'), false);
});
