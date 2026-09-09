import { getMatrixClient } from './matrix';
export const rolesEvent = 'io.tavern.roles';
export const rolePermissions = { send_messages: 'Send messages and encrypted content', add_reactions: 'Add reactions', pin_messages: 'Pin messages', manage_messages: 'Remove others’ messages', join_calls: 'Join calls and conferences', invite: 'Invite people', kick: 'Remove members', ban: 'Ban members', timeout: 'Temporarily restrict members', manage_channels: 'Manage channels', manage_roles: 'Manage lower roles', manage_server: 'Manage server details' } as const;
export type RolePermission = keyof typeof rolePermissions;
export type ServerRole = { id: string; name: string; color: string; icon: string; position: number; permissions: RolePermission[]; mentionable: boolean; separate: boolean };
export type PermissionOverride = Partial<Record<RolePermission, -1 | 0 | 1>>;
export type RolePolicy = { version: 1; owner: string; roles: ServerRole[]; members: Record<string, string[]>; overrides: Record<string, { roles: Record<string, PermissionOverride>; users: Record<string, PermissionOverride> }> };
export function parseRolePolicy(value: any): RolePolicy | null {
  if (!value || value.version !== 1 || typeof value.owner !== 'string' || !value.owner.startsWith('@') || !Array.isArray(value.roles) || value.roles.length > 100 || !value.roles.length || !value.members || typeof value.members !== 'object' || Array.isArray(value.members)) return null;
  const ids = new Set<string>(), positions = new Set<number>();
  for (const role of value.roles) {
    if (!role || typeof role.id !== 'string' || !/^[\w-]{1,80}$/.test(role.id) || ids.has(role.id) || typeof role.name !== 'string' || !role.name.trim() || role.name.length > 60 || !Number.isInteger(role.position) || role.position < 0 || role.position >= 1000 || positions.has(role.position) || (role.id === 'everyone') !== (role.position === 0) || !Array.isArray(role.permissions) || role.permissions.some((p: string) => !(p in rolePermissions)) || (role.color && !/^#[a-f\d]{6}$/i.test(role.color)) || typeof (role.icon || '') !== 'string' || (role.icon || '').length > 16) return null;
    ids.add(role.id); positions.add(role.position);
  }
  if (!ids.has('everyone') || Object.keys(value.members).length > 1000 || Object.entries(value.members).some(([user, roles]) => !user.startsWith('@') || !Array.isArray(roles) || roles.length > 100 || roles.some(r => !ids.has(r)))) return null;
  const overrides = value.overrides || {}; if (typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > 1000) return null;
  for (const [room, kinds] of Object.entries(overrides) as [string, any][]) { if (!room.startsWith('!') || !kinds || typeof kinds !== 'object') return null; for (const kind of ['roles', 'users']) { const targets = kinds[kind] || {}; if (typeof targets !== 'object' || Array.isArray(targets) || Object.keys(targets).length > 1000) return null; for (const [target, permissions] of Object.entries(targets)) { if ((kind === 'roles' ? !ids.has(target) : !target.startsWith('@')) || !permissions || typeof permissions !== 'object' || Array.isArray(permissions) || Object.entries(permissions).some(([p, v]) => !(p in rolePermissions) || ['manage_roles', 'manage_server'].includes(p) || ![-1, 0, 1].includes(v))) return null; } } }
  return { version: 1, owner: value.owner, roles: value.roles.map((r: ServerRole) => ({ ...r, color: r.color || '', icon: r.icon || '', mentionable: r.mentionable === true, separate: r.separate === true })), members: value.members, overrides };
}
export function defaultRolePolicy(owner: string): RolePolicy { return { version: 1, owner, roles: [{ id: 'everyone', name: 'Member', color: '', icon: '', position: 0, permissions: ['send_messages', 'add_reactions', 'join_calls', 'invite'], mentionable: false, separate: false }], members: {}, overrides: {} }; }
export function readRolePolicy(serverId: string) { return parseRolePolicy(getMatrixClient()?.getRoom(serverId)?.currentState.getStateEvents(rolesEvent, '')?.getContent()); }
export function memberServerRoles(policy: RolePolicy, user: string) { const ids = new Set(['everyone', ...(policy.members[user] || [])]); return policy.roles.filter(r => ids.has(r.id)).sort((a, b) => b.position - a.position); }
export function memberRoleRank(policy: RolePolicy, user: string) { return user === policy.owner ? 1001 : Math.max(0, ...memberServerRoles(policy, user).map(r => r.position)); }
export function effectiveRolePermissions(policy: RolePolicy, user: string, roomId?: string): Set<RolePermission> {
  if (user === policy.owner) return new Set(Object.keys(rolePermissions) as RolePermission[]);
  const roles = memberServerRoles(policy, user), result = new Set(roles.flatMap(r => r.permissions)), override = roomId ? policy.overrides[roomId] : undefined;
  for (const p of Object.keys(rolePermissions) as RolePermission[]) { if (p === 'manage_roles' || p === 'manage_server') continue; const values = roles.map(r => override?.roles?.[r.id]?.[p] || 0); if (values.includes(-1)) result.delete(p); else if (values.includes(1)) result.add(p); const own = override?.users?.[user]?.[p]; if (own === -1) result.delete(p); else if (own === 1) result.add(p); }
  return result;
}
export function canManageServerRoles(serverId: string) { const c = getMatrixClient(), r = c?.getRoom(serverId), user = c?.getUserId(), policy = readRolePolicy(serverId); if (!c || !r || !user || !r.currentState.maySendStateEvent(rolesEvent, user)) return false; return policy ? effectiveRolePermissions(policy, user).has('manage_roles') : r.currentState.getStateEvents('m.room.create', '')?.getSender() === user; }
export async function saveRolePolicy(serverId: string, policy: RolePolicy) { const c = getMatrixClient(), me = c?.getUserId(), r = c?.getRoom(serverId); if (!c || !me || !r?.isSpaceRoom() || r.getMyMembership() !== 'join' || !r.currentState.maySendStateEvent(rolesEvent, me)) throw new Error('You do not have permission to manage this server.'); if (!parseRolePolicy(policy)) throw new Error('The role policy is invalid. Check role positions and assigned members.'); await c.sendStateEvent(serverId, rolesEvent as any, policy, ''); }
