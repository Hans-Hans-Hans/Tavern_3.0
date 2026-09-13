import { memberServerRoles, type RolePolicy } from './roles';
import { memberRolePresentation } from './role-presentation';
export type DirectoryMember = { userId: string; name: string; powerLevel: number; presence: string };
export function groupDirectoryMembers<T extends DirectoryMember>(members: T[], policy: RolePolicy | null, query = '') {
  const groups = new Map<string, { id: string; name: string; rank: number; icon?: string; color?: string; members: T[] }>(), term = query.trim().toLocaleLowerCase();
  for (const member of members) {
    const roles = policy ? memberServerRoles(policy, member.userId) : [], owner = policy?.owner === member.userId, separate = memberRolePresentation(policy, member.userId).groupRole, online = member.presence === 'online' || member.presence === 'unavailable';
    if (term && !(member.userId + ' ' + member.name + ' ' + roles.map(role => role.name).join(' ') + (owner ? ' owner' : '')).toLocaleLowerCase().includes(term)) continue;
    const group = !online ? { id: 'presence:offline', name: 'Offline', rank: 0 } : separate ? { id: 'role:' + separate.id, name: separate.name, rank: separate.position + 10, icon: separate.icon, color: separate.color } : !policy && member.powerLevel >= 50 ? { id: member.powerLevel >= 100 ? 'native:administrators' : 'native:moderators', name: member.powerLevel >= 100 ? 'Administrators' : 'Moderators', rank: member.powerLevel } : { id: 'presence:online', name: 'Online', rank: 1 };
    if (!groups.has(group.id)) groups.set(group.id, { ...group, members: [] }); groups.get(group.id)!.members.push(member);
  }
  return [...groups.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name)).map(group => ({ ...group, members: group.members.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)) }));
}
