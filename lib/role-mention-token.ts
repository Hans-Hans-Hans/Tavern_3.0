export type RoleMentionIdentity = { serverId: string; roleId: string };
const prefix = 'tavern-role:';
const roleId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,80}$/.test(value);
const serverId = (value: unknown): value is string => typeof value === 'string' && /^![^\s\x00-\x1f\x7f]{1,1023}$/.test(value);
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());

/** Stable role identity; this URI never authorizes navigation or membership. */
export function roleMentionUri(server: string, role: string): string {
  if (!serverId(server) || !roleId(role)) throw new Error('This server role cannot be mentioned.');
  return prefix + encode(server) + '/' + role;
}
export function parseRoleMentionUri(value: unknown): RoleMentionIdentity | null {
  if (typeof value !== 'string' || value.length > 3200 || !value.startsWith(prefix)) return null;
  const parts = value.slice(prefix.length).split('/');
  if (parts.length !== 2 || !roleId(parts[1])) return null;
  try {
    const server = decodeURIComponent(parts[0]);
    return serverId(server) && roleMentionUri(server, parts[1]) === value ? { serverId: server, roleId: parts[1] } : null;
  } catch { return null; }
}
export function roleMentionToken(value: RoleMentionIdentity & { name: string }): string {
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 60 || /[\r\n\x00-\x1f\x7f]/.test(value.name)) throw new Error('This role name cannot be inserted.');
  const label = ('@' + value.name).replace(/[\\`*_{}\[\]<>()#+\-.!|]/g, '\\$&');
  return '[' + label + '](' + roleMentionUri(value.serverId, value.roleId) + ')';
}
