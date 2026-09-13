import { memberServerRoles, type RolePolicy } from './roles';

/** Color, icon and member-list grouping are independent hierarchy choices. */
export function memberRolePresentation(policy: RolePolicy | null, user: string) {
  const roles = policy ? memberServerRoles(policy, user) : [];
  return { color: roles.find(role => role.color)?.color || '', iconRole: roles.find(role => role.icon),
    groupRole: roles.find(role => role.id !== 'everyone' && role.separate),
    badges: roles.filter(role => role.id !== 'everyone'), owner: policy?.owner === user };
}
