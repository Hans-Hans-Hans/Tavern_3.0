import type { RolePermission, RolePolicy, ServerRole } from './roles';

export const permissionGroups: { name: string; permissions: RolePermission[] }[] = [
  { name: 'Conversation', permissions: ['send_messages', 'create_private_threads', 'add_reactions', 'pin_messages', 'invite'] },
  { name: 'Voice and video', permissions: ['join_calls', 'speak', 'video', 'screen_share', 'mute_members', 'deafen_members'] },
  { name: 'Moderation', permissions: ['manage_messages', 'manage_reports', 'manage_nicknames', 'kick', 'ban', 'timeout'] },
  { name: 'Server management', permissions: ['manage_channels', 'manage_webhooks', 'manage_roles', 'manage_server'] },
];
export const roleColors = ['#b78a56', '#e76f51', '#e9c46a', '#52b788', '#48bfe3', '#6699ff', '#b48cf2', '#e58bc9'];
export const roleIcons = ['⭐', '🛡️', '🎮', '🎨', '🎵', '📚', '🌱', '☕', '🧭', '💻', '🏆', '💬'];

export function nextRolePosition(policy: RolePolicy, rank: number) {
  const used = new Set(policy.roles.map(role => role.position));
  for (let position = 1; position < Math.min(1000, rank); position++) if (!used.has(position)) return position;
  return null;
}
export function roleCopy(policy: RolePolicy, rank: number, id: string, original?: ServerRole): ServerRole {
  const position = nextRolePosition(policy, rank);
  if (policy.roles.length >= 100 || position === null) throw new Error('No role position is available below your highest role.');
  if (original && original.position >= rank) throw new Error('You can duplicate only roles below your highest role.');
  return { id, name: original ? original.name.slice(0, 55) + ' copy' : 'New role', position,
    color: original?.color || '#b78a56', icon: original?.icon || '', ...(original?.iconMxc ? { iconMxc: original.iconMxc } : {}), permissions: [...(original?.permissions || [])],
    mentionable: false, separate: original?.separate || false };
}
export function removeRole(policy: RolePolicy, id: string): RolePolicy {
  if (id === 'everyone') throw new Error('The default Member role cannot be removed.');
  if (roleRemovalImpact(policy, id).audiences) throw new Error('This role controls a private-channel audience. Update that audience in channel settings before removing the role.');
  const clean = (targets: RolePolicy['overrides']) => Object.fromEntries(Object.entries(targets).map(([key, value]) =>
    [key, { ...value, roles: Object.fromEntries(Object.entries(value.roles).filter(([role]) => role !== id)) }]));
  return { ...policy, roles: policy.roles.filter(role => role.id !== id),
    members: Object.fromEntries(Object.entries(policy.members).map(([user, ids]) => [user, ids.filter(role => role !== id)])),
    overrides: clean(policy.overrides), categoryOverrides: clean(policy.categoryOverrides) };
}

export function roleRemovalImpact(policy: RolePolicy, id: string) {
  return { members: Object.values(policy.members).filter(ids => ids.includes(id)).length,
    channels: Object.values(policy.overrides).filter(targets => Object.hasOwn(targets.roles, id)).length,
    categories: Object.values(policy.categoryOverrides).filter(targets => Object.hasOwn(targets.roles, id)).length,
    audiences: Object.values(policy.channelAdmissions || {}).filter(audience => audience.roleIds.includes(id)).length };
}

/** Move through existing positions; protected ranks and the default never move. */
export function moveRole(policy: RolePolicy, id: string, target: string, rank: number): RolePolicy {
  if (id === target) return policy;
  const ordered = [...policy.roles].sort((a, b) => b.position - a.position);
  const from = ordered.findIndex(role => role.id === id), to = ordered.findIndex(role => role.id === target);
  if (from < 0 || to < 0) throw new Error('That role is no longer available.');
  const affected = ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
  if (affected.some(role => role.id === 'everyone' || role.position >= rank)) throw new Error('Move roles only within the positions below your authority.');
  const positions = ordered.map(role => role.position), reordered = [...ordered];
  reordered.splice(to, 0, reordered.splice(from, 1)[0]);
  const next = new Map(reordered.map((role, index) => [role.id, positions[index]]));
  return { ...policy, roles: policy.roles.map(role => ({ ...role, position: next.get(role.id)! })) };
}
