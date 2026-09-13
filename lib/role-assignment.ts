import { effectiveRolePermissions, memberRoleRank, nativeMemberPower, parseRolePolicy, type RolePolicy, type ServerRole } from './roles';

export const bulkRoleLimit = 50;
export function roleAssignmentIssue(authority: RolePolicy, draft: RolePolicy, actor: string, user: string, role: ServerRole, room: any, add: boolean): string | null {
  const rank = memberRoleRank(authority, actor), grants = effectiveRolePermissions(authority, actor);
  if (!grants.has('manage_roles')) return 'You no longer have permission to manage roles.';
  if (role.id === 'everyone') return 'Everyone receives the default role automatically.';
  if (role.position >= rank || (authority.roles.find(item => item.id === role.id)?.position ?? 0) >= rank) return 'This role is at or above your highest role.';
  if (user === actor) return 'You cannot change your own assignments here.';
  if (room?.getMember(user)?.membership !== 'join') return 'This member is no longer joined.';
  if (memberRoleRank(authority, user) >= rank || memberRoleRank(draft, user) >= rank) return 'This member has an equal or higher role.';
  try { if (nativeMemberPower(room, user) >= nativeMemberPower(room, actor)) return 'This member has equal or higher server authority.'; }
  catch { return 'This member’s server authority is unavailable.'; }
  if (add && role.permissions.some(permission => !grants.has(permission))) return 'You cannot grant permissions you do not have.';
  return null;
}

/** Change one role in a bounded draft, preserving every other assignment. */
export function assignRoleDraft(draft: RolePolicy, authority: RolePolicy, actor: string, roleId: string, users: string[], add: boolean, room: any): RolePolicy {
  const role = draft.roles.find(item => item.id === roleId);
  if (!role || !users.length || users.length > bulkRoleLimit || new Set(users).size !== users.length) throw new Error('Choose between 1 and 50 distinct members for an available role.');
  const members = { ...draft.members };
  for (const user of users) {
    const issue = roleAssignmentIssue(authority, draft, actor, user, role, room, add);
    if (issue) throw new Error(issue + ' Review the selected members before trying again.');
    const ids = new Set(members[user] || []);
    if (add) ids.add(roleId); else ids.delete(roleId);
    members[user] = [...ids];
  }
  const result = { ...draft, members };
  if (!parseRolePolicy(result)) throw new Error('These assignments exceed the server role limits. Remove unused assignments before adding more.');
  return result;
}
