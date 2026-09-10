/** These are RTP source permissions, never proof of captured media origin. */
export const publicationPermissions = ['speak', 'video', 'screen_share'] as const;
export function isPublicationPermission(value: string) { return (publicationPermissions as readonly string[]).includes(value); }
export function validPublicationVersion(value: any) {
  if (Object.hasOwn(value, 'callPublicationVersion')) return value.callPublicationVersion === 1;
  return !value.roles.some((role: any) => role.permissions.some(isPublicationPermission))
    && !['overrides', 'categoryOverrides'].some(kind => Object.values(value[kind] || {}).some((targets: any) => ['roles', 'users'].some(type => Object.values(targets[type] || {}).some((permissions: any) => Object.keys(permissions).some(isPublicationPermission)))));
}
export function migratePublicationPolicy<T extends { roles: { id: string; permissions: string[] }[] }>(value: T): T & { callPublicationVersion: 1 } {
  const result = structuredClone(value) as T & { callPublicationVersion: 1; 'io.tavern.previous_event'?: unknown };
  delete result['io.tavern.previous_event'];
  result.callPublicationVersion = 1;
  for (const role of result.roles) if (role.id === 'everyone') role.permissions.push(...publicationPermissions.filter(grant => !role.permissions.includes(grant)));
  return result;
}
