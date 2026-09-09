import type { MatrixClient } from 'matrix-js-sdk';
import { getMatrixClient } from './matrix';
export const notificationPreferencesKey = 'io.tavern.notification_preferences';
export const notificationDefaultsEvent = 'io.tavern.notification.defaults';
export type NotificationDefault = { version: 1; mode: NotificationMode | 'inherit' };
export function normalizeNotificationDefault(value: any): NotificationDefault { return { version: 1, mode: ['all', 'mentions', 'nothing'].includes(value?.mode) ? value.mode : 'inherit' }; }
export type NotificationMode = 'all' | 'mentions' | 'nothing';
export type NotificationScope = { mode: NotificationMode | 'inherit'; mutedUntil: number };
export type NotificationPreferences = { version: 1; global: NotificationScope & { mode: NotificationMode; sound: boolean; useServerDefaults: boolean; friendRequests: boolean; incomingCalls: boolean }; servers: Record<string, NotificationScope>; rooms: Record<string, NotificationScope> };
const scope = (value: any): NotificationScope => ({ mode: ['all', 'mentions', 'nothing'].includes(value?.mode) ? value.mode : 'inherit', mutedUntil: value?.mutedUntil === -1 ? -1 : Number.isSafeInteger(value?.mutedUntil) && value.mutedUntil > 0 ? value.mutedUntil : 0 });
export function normalizeNotificationPreferences(value: any): NotificationPreferences { const groups = (value: any) => Object.fromEntries(value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).slice(0, 1000).filter(([id]) => id.startsWith('!') && id.length <= 255).map(([id, setting]) => [id, scope(setting)]) : []); const global = scope(value?.global); return { version: 1, global: { ...global, mode: global.mode === 'inherit' ? 'all' : global.mode, sound: value?.global?.sound === true, friendRequests: value?.global?.friendRequests !== false, incomingCalls: value?.global?.incomingCalls !== false, useServerDefaults: typeof value?.global?.useServerDefaults === 'boolean' ? value.global.useServerDefaults : global.mode === 'inherit' }, servers: groups(value?.servers), rooms: groups(value?.rooms) }; }
export function readNotificationPreferences(client: MatrixClient | null = getMatrixClient()) { return normalizeNotificationPreferences(client?.getAccountData(notificationPreferencesKey as any)?.getContent()); }
export function readNotificationDefaults(roomId?: string, serverId?: string, client: MatrixClient | null = typeof getMatrixClient === 'function' ? getMatrixClient() : null) {
  serverId ||= roomId && client ? notificationServerForRoom(client, roomId) : undefined;
  const read = (id?: string) => normalizeNotificationDefault(id ? client?.getRoom(id)?.currentState.getStateEvents(notificationDefaultsEvent, '')?.getContent() : null).mode;
  return { server: read(serverId), channel: roomId && roomId !== serverId ? read(roomId) : 'inherit' as const };
}
export function resolveNotificationPreference(prefs: NotificationPreferences, roomId?: string, serverId?: string, now = Date.now(), defaults = readNotificationDefaults(roomId, serverId)) {
  const client = typeof getMatrixClient === 'function' ? getMatrixClient() : null;
  serverId ||= roomId && client ? notificationServerForRoom(client, roomId) : undefined;
  let mode: NotificationMode = prefs.global.mode, source = 'Global', mutedUntil = 0;
  if (prefs.global.useServerDefaults) for (const [name, value] of [['Server default', defaults.server], ['Channel default', defaults.channel]] as const) if (value !== 'inherit') { mode = value; source = name; }
  for (const [name, value] of [['Global', prefs.global], ['Server', serverId && prefs.servers[serverId]], ['Channel', roomId && prefs.rooms[roomId]]] as [string, NotificationScope | undefined | false | ''][]) { if (!value) continue; if (name !== 'Global' && value.mode !== 'inherit') { mode = value.mode; source = name; } if (value.mutedUntil === -1) mutedUntil = -1; else if (mutedUntil !== -1 && value.mutedUntil > now) mutedUntil = Math.max(mutedUntil, value.mutedUntil); }
  return { mode, source, muted: mutedUntil === -1 || mutedUntil > now, mutedUntil, sound: prefs.global.sound };
}
export function notificationEligible(setting: ReturnType<typeof resolveNotificationPreference>, options: { mention: boolean; ignored: boolean; dnd: boolean; own: boolean; nativeNotify?: boolean }) { if (setting.muted || options.ignored || options.dnd || options.own || options.nativeNotify === false || setting.mode === 'nothing') return false; return setting.mode === 'all' || options.mention; }
export function notificationServerForRoom(client: MatrixClient, roomId: string) { const room = client.getRoom(roomId); return room?.isSpaceRoom() ? roomId : room?.currentState.getStateEvents('m.space.parent').filter(e => e.getContent().canonical && e.getContent().via?.length).map(e => e.getStateKey()!).find(id => client.getRoom(id)?.currentState.getStateEvents('m.space.child', roomId)?.getContent().via?.length); }
let queue: Promise<unknown> = Promise.resolve();
export function updateNotificationPreferences(mutate: (old: NotificationPreferences) => NotificationPreferences, client = getMatrixClient()) { if (!client) throw new Error('Sign in to change notification preferences.'); const task = queue.catch(() => {}).then(async () => { const fresh = await client.getAccountDataFromServer(notificationPreferencesKey as any); const next = normalizeNotificationPreferences(mutate(normalizeNotificationPreferences(fresh))); await client.setAccountData(notificationPreferencesKey as any, next as any); return next; }); queue = task; return task; }
