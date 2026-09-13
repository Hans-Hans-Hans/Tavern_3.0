import { effectiveRolePermissions, memberServerRoles, type PermissionTargets, type RolePermission, type RolePolicy } from './roles';

/** A read-only role combination; no member-specific exceptions or impersonation. */
export function explainRolesPermission(policy: RolePolicy, ids: string[], permission: RolePermission, room?: string, category?: string) {
  if (ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !policy.roles.some(role => role.id === id))) throw new Error('Choose current server roles for this preview.');
  // An empty string cannot be a valid Matrix user ID or policy owner.
  return explainRolePermission({ ...policy, members: { ...policy.members, '': ids } }, '', permission, room, category);
}

export function explainRolePermission(policy: RolePolicy, user: string, permission: RolePermission, room?: string, category?: string) {
  const roles = memberServerRoles(policy, user);
  const names = (ids: string[]) => { const values = roles.filter(role => ids.includes(role.id)).map(role => role.name); return values.slice(0, 4).join(', ') + (values.length > 4 ? ` and ${values.length - 4} more` : ''); };
  const base = effectiveRolePermissions(policy, user), middle = effectiveRolePermissions(policy, user, undefined, category), final = effectiveRolePermissions(policy, user, room, category);
  const reason = (targets: PermissionTargets | undefined) => {
    if (user === policy.owner) return 'The server owner retains role authority.';
    if (['manage_roles', 'manage_server', 'manage_nicknames'].includes(permission)) return 'This server-wide action is controlled by server roles.';
    const personal = targets?.users?.[user]?.[permission];
    if (personal === -1 || personal === 1) return `A member-specific rule ${personal === 1 ? 'allows' : 'denies'} this action.`;
    const denies = roles.filter(role => targets?.roles?.[role.id]?.[permission] === -1).map(role => role.id);
    if (denies.length) return 'Denied by ' + names(denies) + '.';
    const allows = roles.filter(role => targets?.roles?.[role.id]?.[permission] === 1).map(role => role.id);
    return allows.length ? 'Allowed by ' + names(allows) + '.' : 'No override; inherits the previous step.';
  };
  let baseReason = user === policy.owner ? 'The server owner retains role authority.' : base.has(permission)
    ? 'Granted by ' + names(roles.filter(role => role.permissions.includes(permission)).map(role => role.id)) + '.' : 'None of this member’s roles grants this action.';
  if (user !== policy.owner && !policy.callPublicationVersion && ['speak', 'video', 'screen_share'].includes(permission)) baseReason = 'Publishing uses the existing compatibility settings until separate conference permissions are enabled.';
  return [
    { scope: 'Server roles', allowed: base.has(permission), reason: baseReason },
    ...(category ? [{ scope: 'Category rules', allowed: middle.has(permission), reason: reason(policy.categoryOverrides[category]) }] : []),
    ...(room ? [{ scope: 'Channel rules', allowed: final.has(permission), reason: reason(policy.overrides[room]) }] : []),
  ];
}
