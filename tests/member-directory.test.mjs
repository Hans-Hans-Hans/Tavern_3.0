import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const roles = loadTs('../lib/roles.ts', { './api': { accountArtworkOwner: () => 0 }, './conference-publication': loadTs('../lib/conference-publication.ts', {}), './matrix': {} });
const { groupDirectoryMembers } = loadTs('../lib/member-directory.ts', { './roles': roles, './role-presentation': loadTs('../lib/role-presentation.ts', { './roles': roles }) });
test('online members use their highest separately displayed role while offline members remain together', () => {
  const p = roles.defaultRolePolicy('@owner:local'); p.roles.push({ id: 'mod', name: 'Moderator', position: 10, separate: true }, { id: 'raider', name: 'Raider', position: 20, separate: false }); p.members['@a:local'] = ['mod', 'raider'];
  const members = [{ userId: '@owner:local', name: 'Owner', presence: 'offline', powerLevel: 100 }, { userId: '@a:local', name: 'A', presence: 'online', powerLevel: 0 }, { userId: '@b:local', name: 'B', presence: 'online', powerLevel: 0 }, { userId: '@c:local', name: 'C', presence: 'offline', powerLevel: 0 }];
  assert.deepEqual(groupDirectoryMembers(members, p).map(g => g.name), ['Moderator', 'Online', 'Offline']);
  assert.equal(groupDirectoryMembers(members, p, 'raider')[0].members[0].userId, '@a:local');
  members[1].presence = 'offline'; assert.equal(groupDirectoryMembers(members, p, 'raider')[0].name, 'Offline');
  assert.equal(groupDirectoryMembers(members, p, 'owner')[0].members[0].userId, '@owner:local');
  assert.equal(groupDirectoryMembers(members, p, 'missing').length, 0);
});
test('custom role IDs cannot collide with presence groups and each member appears once', () => {
  const p = roles.defaultRolePolicy('@owner:local'); p.roles.push({ id: 'online', name: 'Team', position: 10, separate: true }, { id: 'higher', name: 'Leads', position: 20, separate: true });
  p.members = { '@a:local': ['online'], '@b:local': ['online', 'higher'] };
  const members = ['a','b','c'].map(name => ({userId:'@'+name+':local',name,presence:'unavailable',powerLevel:0}));
  const groups = groupDirectoryMembers(members,p); assert.deepEqual(groups.map(g=>g.id),['role:higher','role:online','presence:online']); assert.equal(groups.flatMap(g=>g.members).length,3);
});
