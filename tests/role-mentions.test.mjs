import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { loadTs } from './load-ts.mjs';
import { privateFixture } from './fixtures/private-thread.mjs';

const tokens = loadTs('../lib/role-mention-token.ts', {});
function setup() {
  const f = privateFixture(); let active = true;
  const matrix = { getMatrixClient: () => f.client }, roles = loadTs('../lib/roles.ts', { './matrix': matrix });
  const privateThreads = loadTs('../lib/private-threads.ts', { './matrix': matrix, './roles': roles });
  const markdown = loadTs('../lib/message-markdown.ts', { 'markdown-it': { default: MarkdownIt }, './role-mention-token': tokens });
  const api = loadTs('../lib/role-mentions.ts', { './message-markdown': markdown, './roles': roles, './private-threads': privateThreads, './role-mention-token': tokens });
  for (const room of f.client.getRooms()) room.getJoinedMemberCount = () => room.getJoinedMembers().length;
  f.policy.roles[1].mentionable = true; f.policy.roles[1].name = 'Helpers'; f.policy.members[f.member] = ['mod'];
  f.policy.roles.push({ id: 'other', name: 'Helpers', position: 60, permissions: [], mentionable: true });
  f.policy.members[f.other] = ['other'];
  return { ...f, api, deactivate: () => { active = false; }, expand: (body, id = f.sourceId) => api.expandRoleMentions(f.client, id, body, () => active), token: (roleId = 'mod', name = 'Helpers') => tokens.roleMentionToken({ serverId: f.serverId, roleId, name }) };
}
test('stable role identity survives duplicate names and renames, with strict inert URI parsing', () => {
  const f = setup(), token = f.token();
  assert.deepEqual(f.api.selectedRoleMentions(token), [{ serverId: f.serverId, roleId: 'mod' }]);
  assert.notEqual(token, f.token('other'));
  assert.deepEqual(f.api.selectedRoleMentions(f.token('mod', 'Renamed [role] *')), [{ serverId: f.serverId, roleId: 'mod' }]);
  for (const uri of ['javascript:alert(1)', 'tavern-role:%21server%3atest/mod', 'tavern-role:!server:test/mod', 'tavern-role:%21server%3Atest/mod?other', 'tavern-role:%21server%3Atest/../mod', 'tavern-role:%FF/mod']) assert.equal(tokens.parseRoleMentionUri(uri), null, uri);
});
test('role tokens in code and escaped examples do not expand; too many selections fail explicitly', () => {
  const f = setup(), token = f.token();
  assert.deepEqual(f.api.selectedRoleMentions('`' + token + '`\n\n```text\n' + token + '\n```'), []);
  assert.deepEqual(f.api.selectedRoleMentions('\\' + token), []);
  assert.throws(() => f.api.selectedRoleMentions(Array(21).fill(token).join(' ')), /up to 20/);
  assert.deepEqual(f.api.selectedRoleMentions('[@Bad](tavern-role:invalid/role)'), []);
});
test('current role assignment expands only joined target and server members and cannot match a same-name person', async () => {
  const f = setup(), result = await f.expand(f.token() + ' @Charlie');
  assert.deepEqual(result.userIds.sort(), [f.author, f.member].sort());
  assert.equal(result.bodyForUserMentions.trim(), '@Charlie');
  f.states.get(f.serverId).find(event => event.type === 'm.room.member' && event.state_key === f.member).content.membership = 'leave';
  assert.deepEqual((await f.expand(f.token())).userIds, [f.author]);
  f.states.get(f.sourceId).find(event => event.type === 'm.room.member' && event.state_key === f.author).content.membership = 'invite';
  await assert.rejects(f.expand(f.token()), /Join this conversation/);
});
test('private discussion roles come from the verified source but never expand source-only people', async () => {
  const f = setup();
  assert.deepEqual((await f.expand(f.token('other'), f.privateId)).userIds, []);
  assert.deepEqual((await f.expand(f.token(), f.privateId)).userIds.sort(), [f.author, f.member].sort());
  f.states.get(f.sourceId).find(event => event.type === 'm.room.member' && event.state_key === f.member).content.membership = 'leave';
  assert.deepEqual((await f.expand(f.token(), f.privateId)).userIds, [f.author]);
});
test('foreign or nonreciprocal roles are rejected before any member request', async () => {
  const f = setup(); let loads = 0;
  for (const room of f.client.getRooms()) room.loadMembersIfNeeded = async () => { loads++; };
  await assert.rejects(f.expand(tokens.roleMentionToken({ serverId: '!foreign:test', roleId: 'mod', name: 'Helpers' })), /no longer mentionable/);
  assert.equal(loads, 0);
  f.states.get(f.serverId).find(event => event.type === 'm.space.child').content = {};
  assert.deepEqual(f.api.roleMentionChoices(f.client, f.sourceId), []);
  await assert.rejects(f.expand(f.token()), /canonical server/); assert.equal(loads, 0);
});
test('account replacement and role revocation during member loading preserve unsent work', async () => {
  const f = setup(); f.client.getRoom(f.sourceId).loadMembersIfNeeded = async () => { f.deactivate(); };
  await assert.rejects(f.expand(f.token()), /account or room membership changed/);
  const g = setup(); g.client.getRoom(g.serverId).loadMembersIfNeeded = async () => { g.policy.roles[1].mentionable = false; };
  await assert.rejects(g.expand(g.token()), /no longer mentionable/);
  const h = setup(); h.client.getRoom(h.serverId).loadMembersIfNeeded = async () => { h.states.get(h.serverId).find(event => event.type === 'm.space.child').content = {}; };
  await assert.rejects(h.expand(h.token()), /canonical server/);
});
test('incomplete or oversized membership fails instead of silently mentioning a partial audience', async () => {
  const f = setup(), room = f.client.getRoom(f.sourceId);
  room.getJoinedMemberCount = () => 10001; await assert.rejects(f.expand(f.token()), /too large/);
  room.getJoinedMemberCount = () => 6; await assert.rejects(f.expand(f.token()), /full current membership/);
});
test('a later membership load or send cannot reuse an audience whose joined summary became incomplete', async () => {
  const f = setup();
  f.client.getRoom(f.serverId).loadMembersIfNeeded = async () => { f.client.getRoom(f.sourceId).getJoinedMemberCount = () => 5; };
  await assert.rejects(f.expand(f.token()), /full current membership/);
  const g = setup(), result = await g.expand(g.token());
  g.client.getRoom(g.sourceId).getJoinedMemberCount = () => 5;
  assert.throws(() => result.assertCurrent(), /full current membership/);
});
test('mention and combined content byte limits reject long IDs as well as recipient count', () => {
  const f = setup(); f.api.checkRoleMentionSize({ user_ids: ['@alice:test'] }, { body: 'hello' });
  assert.throws(() => f.api.checkRoleMentionSize({ user_ids: Array.from({ length: 1001 }, (_, index) => '@u' + index + ':test') }), /too large/);
  assert.throws(() => f.api.checkRoleMentionSize({ user_ids: Array.from({ length: 40 }, (_, index) => '@u' + index + ':' + 'x'.repeat(500)) }), /too large/);
  assert.throws(() => f.api.checkRoleMentionSize({ user_ids: [] }, { body: '😀'.repeat(9000) }), /message and its role mentions/);
});
