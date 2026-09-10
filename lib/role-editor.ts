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
    color: original?.color || '#b78a56', icon: original?.icon || '', permissions: [...(original?.permissions || [])],
    mentionable: false, separate: original?.separate || false };
}
export function removeRole(policy: RolePolicy, id: string): RolePolicy {
  if (id === 'everyone') throw new Error('The default Member role cannot be removed.');
  const clean = (targets: RolePolicy['overrides']) => Object.fromEntries(Object.entries(targets).map(([key, value]) =>
    [key, { ...value, roles: Object.fromEntries(Object.entries(value.roles).filter(([role]) => role !== id)) }]));
  return { ...policy, roles: policy.roles.filter(role => role.id !== id),
    members: Object.fromEntries(Object.entries(policy.members).map(([user, ids]) => [user, ids.filter(role => role !== id)])),
    overrides: clean(policy.overrides), categoryOverrides: clean(policy.categoryOverrides) };
}
