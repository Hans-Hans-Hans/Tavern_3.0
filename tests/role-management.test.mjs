import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
let client, account = 0;
const roles = loadTs('../lib/roles.ts', { './api': { accountArtworkOwner: () => account }, './conference-publication': loadTs('../lib/conference-publication.ts', {}), './matrix': { getMatrixClient: () => client } });
const { assignRoleDraft, roleAssignmentIssue } = loadTs('../lib/role-assignment.ts', { './roles': roles });
const { explainRolePermission, explainRolesPermission } = loadTs('../lib/role-access.ts', { './roles': roles });
const { moveRole, removeRole, roleRemovalImpact } = loadTs('../lib/role-editor.ts', {});
function fixture() {
  const policy = roles.defaultRolePolicy('@owner:local');
  const role = (id, position, permissions = []) => ({ id, name: id, position, permissions, color: '', icon: '', mentionable: false, separate: false });
  policy.roles.push(role('mod', 50, ['manage_roles', 'pin_messages']), role('tag', 10), role('helper', 20, ['pin_messages']), role('danger', 30, ['manage_server']));
  policy.members = { '@mod:local': ['mod'], '@one:local': ['helper'], '@two:local': [], '@other:local': ['tag'] };
  policy.categoryOverrides.chat = { roles: { helper: { invite: -1 } }, users: {} };
  const powers = { users: { '@owner:local': 100, '@mod:local': 50, '@peer:local': 50 }, users_default: 0 };
  const members = new Map(['@owner:local', '@mod:local', '@one:local', '@two:local', '@other:local', '@peer:local'].map(userId => [userId, { userId, membership: 'join' }]));
  const room = { isSpaceRoom: () => true, getMyMembership: () => 'join', getMember: id => members.get(id), currentState: { maySendStateEvent: () => true, getStateEvents: type => ({ getSender: () => '@owner:local', getContent: () => type === 'm.room.power_levels' ? powers : type === 'm.room.create' ? { type: 'm.space' } : policy }) } };
  return { policy, room, members, powers };
}

test('bulk assignment changes one role for each selected member without losing other roles or permission scopes', () => {
  const f = fixture(), before = structuredClone(f.policy);
  const next = assignRoleDraft(f.policy, f.policy, '@mod:local', 'tag', ['@one:local', '@two:local'], true, f.room);
  assert.deepEqual(next.members['@one:local'], ['helper', 'tag']); assert.deepEqual(next.members['@two:local'], ['tag']);
  assert.deepEqual(next.members['@other:local'], ['tag']); assert.deepEqual(next.categoryOverrides, before.categoryOverrides); assert.deepEqual(f.policy, before);
  assert.deepEqual(assignRoleDraft(next, f.policy, '@mod:local', 'tag', ['@one:local'], false, f.room).members['@one:local'], ['helper']);
});

test('one protected or departed target rejects the entire draft and never partly edits another member', () => {
  for (const target of ['@mod:local', '@owner:local', '@peer:local', '@departed:local']) {
    const f = fixture(), before = structuredClone(f.policy);
    assert.throws(() => assignRoleDraft(f.policy, f.policy, '@mod:local', 'tag', ['@one:local', target], true, f.room));
    assert.deepEqual(f.policy, before);
  }
  const f = fixture(); f.members.get('@two:local').membership = 'leave';
  assert.throws(() => assignRoleDraft(f.policy, f.policy, '@mod:local', 'tag', ['@one:local', '@two:local'], true, f.room), /no longer joined/);
});

test('bulk assignment respects saved and drafted hierarchy and current grants', () => {
  const f = fixture();
  assert.throws(() => assignRoleDraft(f.policy, f.policy, '@mod:local', 'danger', ['@one:local'], true, f.room), /cannot grant/);
  assert.throws(() => assignRoleDraft(f.policy, f.policy, '@mod:local', 'mod', ['@one:local'], true, f.room), /highest role/);
  const draft = structuredClone(f.policy); draft.members['@one:local'].push('mod');
  assert.throws(() => assignRoleDraft(draft, f.policy, '@mod:local', 'tag', ['@one:local'], true, f.room), /equal or higher role/);
  f.policy.members['@one:local'].push('danger');
  assert.deepEqual(assignRoleDraft(f.policy, f.policy, '@mod:local', 'danger', ['@one:local'], false, f.room).members['@one:local'], ['helper']);
  f.powers.users['@one:local'] = 50;
  assert.match(roleAssignmentIssue(f.policy, f.policy, '@mod:local', '@one:local', f.policy.roles[2], f.room, true), /server authority/);
});

test('bulk selection is bounded, explicit and deduplicated before changing a draft', () => {
  const f = fixture();
  for (const users of [[], ['@one:local', '@one:local'], Array.from({ length: 51 }, (_, n) => '@user' + n + ':local')]) assert.throws(() => assignRoleDraft(f.policy, f.policy, '@mod:local', 'tag', users, true, f.room), /1 and 50/);
  assert.throws(() => assignRoleDraft(f.policy, f.policy, '@mod:local', 'everyone', ['@one:local'], false, f.room), /automatically/);
});

test('drag reorder inserts the role using existing ranks and preserves assignments and protected positions', () => {
  const f = fixture(), before = structuredClone(f.policy), next = moveRole(f.policy, 'tag', 'danger', 50);
  assert.deepEqual([...next.roles].sort((a, b) => b.position - a.position).map(role => role.id), ['mod', 'tag', 'danger', 'helper', 'everyone']);
  assert.deepEqual(next.members, before.members); assert.deepEqual(next.categoryOverrides, before.categoryOverrides); assert.deepEqual(f.policy, before); assert.ok(roles.parseRolePolicy(next));
  for (const [source, target] of [['tag', 'mod'], ['tag', 'everyone'], ['mod', 'tag'], ['missing', 'tag']]) assert.throws(() => moveRole(f.policy, source, target, 50));
});

test('role removal reports its impact and requires private audiences to be edited separately', () => {
  const f = fixture(); f.policy.overrides['!channel:local'] = { roles: { helper: { invite: -1 } }, users: {} };
  assert.deepEqual(roleRemovalImpact(f.policy, 'helper'), { members: 1, channels: 1, categories: 1, audiences: 0 });
  const next = removeRole(f.policy, 'helper'); assert.deepEqual(next.members['@one:local'], []); assert.deepEqual(next.overrides['!channel:local'].roles, {}); assert.deepEqual(next.categoryOverrides.chat.roles, {});
  f.policy.channelAdmissionVersion = 1; f.policy.channelAdmissions = { '!channel:local': { roleIds: ['helper'], userIds: [] } };
  assert.equal(roleRemovalImpact(f.policy, 'helper').audiences, 1); assert.throws(() => removeRole(f.policy, 'helper'), /private-channel audience/);
  assert.deepEqual(f.policy.channelAdmissions['!channel:local'].roleIds, ['helper']);
});

test('access explanation follows role denies and explicit member rules in their actual order', () => {
  const f = fixture(); f.policy.categoryOverrides.chat = { roles: { everyone: { send_messages: -1 }, helper: { send_messages: 1 } }, users: {} };
  f.policy.overrides['!channel:local'] = { roles: {}, users: { '@one:local': { send_messages: 1 } } };
  const trace = explainRolePermission(f.policy, '@one:local', 'send_messages', '!channel:local', 'chat');
  assert.deepEqual(trace.map(step => step.allowed), [true, false, true]); assert.match(trace[1].reason, /Denied by Member/); assert.match(trace[2].reason, /member-specific rule allows/);
  assert.ok(explainRolePermission(f.policy, '@owner:local', 'send_messages', '!channel:local', 'chat').every(step => step.allowed));
  assert.match(explainRolePermission(f.policy, '@one:local', 'video', undefined, undefined)[0].reason, /compatibility settings/);
});

test('role previews combine chosen roles without owner or member-specific authority', () => {
  const f = fixture(), before = structuredClone(f.policy);
  f.policy.overrides['!channel:local'] = { roles: { helper: { invite: -1 } }, users: { '@owner:local': { invite: 1 }, '@one:local': { invite: 1 } } };
  assert.equal(explainRolesPermission(f.policy, ['helper','tag'], 'invite', '!channel:local').at(-1).allowed, false);
  assert.equal(explainRolePermission(f.policy, '@one:local', 'invite', '!channel:local').at(-1).allowed, true);
  assert.equal(explainRolesPermission(f.policy, [], 'manage_roles').at(-1).allowed, false);
  assert.equal(explainRolesPermission(f.policy, ['mod'], 'manage_roles').at(-1).allowed, true);
  assert.deepEqual(f.policy.members, before.members); assert.throws(() => explainRolesPermission(f.policy, ['removed'], 'invite'), /current server roles/);
});

test('ordinary unmarked role saves carry the current native revision and reject a changed snapshot', async () => {
  const f = fixture(), writes = []; let raw = structuredClone(f.policy), changed = false;
  client = { getUserId: () => '@owner:local', getRoom: () => f.room, getStateEvent: async () => structuredClone(raw), roomState: async () => [{ type: 'io.tavern.roles', state_key: '', event_id: '$fresh', content: changed ? { ...raw, members: {} } : structuredClone(raw) }], sendStateEvent: async (...args) => writes.push(args) };
  await roles.saveRolePolicy('!server:local', f.policy, f.policy);
  assert.equal(writes[0][2]['io.tavern.previous_event'], '$fresh');
  changed = true; await assert.rejects(roles.saveRolePolicy('!server:local', f.policy, f.policy), /changed while loading/); assert.equal(writes.length, 1);
});

test('bulk saves reject stale cached membership or native rank before sending any policy event', async () => {
  for (const failure of ['left', 'promoted']) {
    const f = fixture(), next = assignRoleDraft(f.policy, f.policy, '@mod:local', 'tag', ['@one:local', '@two:local'], true, f.room), writes = [];
    const event = (type, content, state_key = '') => ({ type, state_key, content, sender: '@owner:local', event_id: '$current' });
    client = { getUserId: () => '@mod:local', getRoom: () => f.room, getStateEvent: async () => structuredClone(f.policy),
      roomState: async () => [event('io.tavern.roles', structuredClone(f.policy)), event('m.room.create', { type: 'm.space' }),
        event('m.room.power_levels', { users: { '@mod:local': 50, '@two:local': failure === 'promoted' ? 50 : 0 } }),
        event('m.room.member', { membership: 'join' }, '@one:local'), event('m.room.member', { membership: failure === 'left' ? 'leave' : 'join' }, '@two:local')],
      sendStateEvent: async (...args) => writes.push(args) };
    await assert.rejects(roles.saveRolePolicy('!server:local', next, f.policy), failure === 'left' ? /no longer joined/ : /equal or higher server authority/);
    assert.equal(writes.length, 0);
  }
});
