import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

function fixture() {
  let client, account = 0, raw, eventId = '$saved', writes = [], afterRead = () => {};
  const publication = loadTs('../lib/conference-publication.ts', {});
  const roles = loadTs('../lib/roles.ts', { './conference-publication': publication,
    './api': { accountArtworkOwner: () => account }, './matrix': { getMatrixClient: () => client } });
  raw = roles.defaultRolePolicy('@owner:test');
  raw.roles.push({ id: 'helper', name: 'Helper', position: 10, color: '#123456', icon: '⭐', permissions: [], separate: true, mentionable: false });
  raw.members['@member:test'] = ['helper'];
  const room = { isSpaceRoom: () => true, getMyMembership: () => 'join', getMember: () => ({ membership: 'join' }), currentState: {
    maySendStateEvent: () => true, getStateEvents: kind => ({ getSender: () => '@owner:test', getId: () => eventId,
      getContent: () => kind === 'm.room.create' ? { type: 'm.space', room_version: '11' } : kind === 'm.room.power_levels' ? { users: { '@owner:test': 100 }, users_default: 0 } : raw }),
  } };
  client = { getUserId: () => '@owner:test', getDeviceId: () => 'DEVICE', getRoom: () => room,
    getStateEvent: async (_room, kind) => { const value = structuredClone(kind === 'm.room.member' ? { membership: 'join' } : kind === 'm.room.power_levels' ? { users: { '@owner:test': 100 } } : raw); await afterRead(); return value; },
    roomState: async () => { const value = [{ type: roles.rolesEvent, state_key: '', event_id: eventId, content: structuredClone(raw) }]; await afterRead(); return value; },
    sendStateEvent: async (_room, _kind, value) => { writes.push(structuredClone(value)); raw = structuredClone(value); eventId = '$next'; },
  };
  return { roles, publication, client, room, writes, get raw() { return raw; }, set raw(value) { raw = value; },
    replaceAccount: () => { account++; }, onRead: fn => { afterRead = fn; } };
}

test('publication migration preserves unknown native data and every old right without mutating the input', async () => {
  const f = fixture(); f.raw.extra = { native: ['preserve'] }; f.raw.categoryOverrides.music = { roles: { everyone: { join_calls: -1 } }, users: {} };
  const before = structuredClone(f.raw), after = await f.roles.enableConferencePublication('!server:test');
  assert.deepEqual(before.roles[0].permissions, ['send_messages', 'add_reactions', 'join_calls', 'invite']);
  assert.deepEqual(f.writes[0].extra, before.extra); assert.deepEqual(after.categoryOverrides, before.categoryOverrides);
  assert.deepEqual(after.members, before.members); assert.equal(f.writes[0]['io.tavern.previous_event'], '$saved');
  assert.equal(after.callPublicationVersion, 1);
  assert.deepEqual(after.roles[0].permissions.slice(-3), ['speak', 'video', 'screen_share']);
});

test('strict marker parsing and inherited publication rights match native legacy behavior', () => {
  const f = fixture(), legacy = structuredClone(f.raw);
  for (const key of f.publication.publicationPermissions) assert.equal(f.roles.effectiveRolePermissions(legacy, '@member:test').has(key), true);
  for (const marker of [false, null, 0, '1', 2]) assert.equal(f.roles.parseRolePolicy({ ...legacy, callPublicationVersion: marker }), null);
  legacy.roles[0].permissions.push('speak'); assert.equal(f.roles.parseRolePolicy(legacy), null);
  const marked = f.publication.migratePublicationPolicy(f.raw);
  marked.categoryOverrides.music = { roles: { everyone: { speak: -1 } }, users: {} };
  marked.overrides['!voice:test'] = { roles: {}, users: { '@member:test': { speak: 1, screen_share: -1 } } };
  assert.equal(f.roles.effectiveRolePermissions(marked, '@member:test', '!voice:test', 'music').has('speak'), true);
  assert.equal(f.roles.effectiveRolePermissions(marked, '@member:test', '!voice:test', 'music').has('screen_share'), false);
});

test('marked saves use the fresh exact native revision and refuse concurrent assignments without discarding the draft', async () => {
  const f = fixture(); f.raw = f.publication.migratePublicationPolicy(f.raw);
  const previous = f.roles.parseRolePolicy(f.raw), draft = structuredClone(previous); draft.roles[1].name = 'Helpers';
  f.raw.members['@new:test'] = ['helper'];
  await assert.rejects(f.roles.saveRolePolicy('!server:test', draft, previous), /changed elsewhere/);
  assert.equal(f.writes.length, 0); assert.equal(draft.roles[1].name, 'Helpers');
  const fresh = f.roles.parseRolePolicy(f.raw), next = structuredClone(fresh); next.roles[1].name = 'Helpers';
  await f.roles.saveRolePolicy('!server:test', next, fresh);
  assert.equal(f.writes[0]['io.tavern.previous_event'], '$saved'); assert.deepEqual(f.writes[0].members['@new:test'], ['helper']);
});

test('role writes preserve fresh category edits but cannot silently enable or remove the publication marker', async () => {
  const f = fixture(), previous = f.roles.parseRolePolicy(f.raw), draft = structuredClone(previous); draft.roles[1].icon = '🛡️';
  f.raw.categoryOverrides.music = { roles: { everyone: { invite: -1 } }, users: {} };
  await f.roles.saveRolePolicy('!server:test', draft, previous);
  assert.equal(f.raw.categoryOverrides.music.roles.everyone.invite, -1);
  await assert.rejects(f.roles.saveRolePolicy('!server:test', f.publication.migratePublicationPolicy(draft)), /separate migration/);
  f.raw = f.publication.migratePublicationPolicy(f.raw);
  await assert.rejects(f.roles.saveRolePolicy('!server:test', draft), /separate migration/);
});

test('migration, role save and queued member assignment reject API account A→B→A across native reads', async () => {
  for (const operation of ['migration', 'roles', 'member']) {
    const f = fixture(); f.onRead(() => f.replaceAccount());
    const result = operation === 'migration' ? f.roles.enableConferencePublication('!server:test')
      : operation === 'roles' ? f.roles.saveRolePolicy('!server:test', f.roles.parseRolePolicy(f.raw))
      : f.roles.saveMemberRoles('!server:test', '@member:test', [], ['helper']);
    await assert.rejects(result, /account/); assert.equal(f.writes.length, 0);
  }
});

test('role presentation groups cover each real permission once and safe copies never assign people', () => {
  const f = fixture(), editor = loadTs('../lib/role-editor.ts', {});
  assert.deepEqual(editor.permissionGroups.flatMap(group => group.permissions).sort(), Object.keys(f.roles.rolePermissions).sort());
  const copy = editor.roleCopy(f.raw, 1001, 'new-copy', f.raw.roles[1]);
  assert.equal(copy.name, 'Helper copy'); assert.equal(copy.position, 1); assert.equal(copy.mentionable, false);
  assert.notEqual(copy.permissions, f.raw.roles[1].permissions);
  assert.deepEqual(f.raw.members, { '@member:test': ['helper'] });
  assert.throws(() => editor.roleCopy(f.raw, 10, 'invalid', f.raw.roles[1]), /below/);
  f.raw.overrides['!voice:test'] = { roles: { helper: { invite: -1 } }, users: {} };
  f.raw.categoryOverrides.music = { roles: { helper: { invite: -1 } }, users: {} };
  const removed = editor.removeRole(f.raw, 'helper');
  assert.deepEqual(removed.members['@member:test'], []); assert.deepEqual(removed.overrides['!voice:test'].roles, {}); assert.deepEqual(removed.categoryOverrides.music.roles, {});
  assert.throws(() => editor.removeRole(f.raw, 'everyone'), /cannot be removed/);
});
