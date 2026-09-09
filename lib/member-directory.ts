import { memberServerRoles, type RolePolicy } from './roles';
export type DirectoryMember = { userId: string; name: string; powerLevel: number; presence: string };
export function groupDirectoryMembers<T extends DirectoryMember>(members: T[], policy: RolePolicy | null, query = '') {
  const groups = new Map<string, { id: string; name: string; rank: number; members: T[] }>(), term = query.trim().toLocaleLowerCase();
  for (const member of members) {
    const roles = policy ? memberServerRoles(policy, member.userId) : [], owner = policy?.owner === member.userId, separate = roles.find(role => role.separate), online = member.presence === 'online' || member.presence === 'unavailable';
    if (term && !(member.userId + ' ' + member.name + ' ' + roles.map(role => role.name).join(' ') + (owner ? ' owner' : '')).toLocaleLowerCase().includes(term)) continue;
    const group = owner ? { id: 'owner', name: 'Owner', rank: 2000 } : separate ? { id: separate.id, name: separate.name, rank: separate.position + 10 } : !policy && member.powerLevel >= 50 ? { id: member.powerLevel >= 100 ? 'administrators' : 'moderators', name: member.powerLevel >= 100 ? 'Administrators' : 'Moderators', rank: member.powerLevel } : { id: online ? 'online' : 'offline', name: online ? 'Online' : 'Offline', rank: online ? 1 : 0 };
    if (!groups.has(group.id)) groups.set(group.id, { ...group, members: [] }); groups.get(group.id)!.members.push(member);
  }
  return [...groups.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name)).map(group => ({ ...group, members: group.members.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)) }));
}
