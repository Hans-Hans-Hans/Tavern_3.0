import { getMatrixClient } from './matrix';
import { serverChannelIds } from './community';
import { effectiveRolePermissions, readRolePolicy, rolesEvent } from './roles';
export const onboardingEvent = 'io.tavern.server.onboarding';
export type ServerOnboarding = { version: 1; enabled: boolean; startChannel: string; recommended: string[]; interests: { id: string; label: string; channels: string[] }[] };
export function normalizeServerOnboarding(value: any): ServerOnboarding {
  const channels = (items: unknown) => [...new Set(Array.isArray(items) ? items.filter(id => typeof id === 'string' && id.startsWith('!') && id.length <= 255) : [])].slice(0, 20) as string[];
  const used = new Set<string>();
  return { version: 1, enabled: value?.enabled === true, startChannel: channels([value?.startChannel])[0] || '', recommended: channels(value?.recommended), interests: (Array.isArray(value?.interests) ? value.interests : []).slice(0, 12).flatMap((item: any) => { if (!item || typeof item.id !== 'string' || !/^[\w-]{1,80}$/.test(item.id) || used.has(item.id) || typeof item.label !== 'string' || !item.label.trim()) return []; used.add(item.id); return [{ id: item.id, label: item.label.trim().slice(0, 80), channels: channels(item.channels) }]; }) };
}
export function readServerOnboarding(serverId: string) { return normalizeServerOnboarding(getMatrixClient()?.getRoom(serverId)?.currentState.getStateEvents(onboardingEvent, '')?.getContent()); }
export function canManageOnboarding(serverId: string) { const client = getMatrixClient(), room = client?.getRoom(serverId), me = client?.getUserId(), policy = readRolePolicy(serverId); return !!(me && room?.isSpaceRoom() && room.getMyMembership() === 'join' && room.currentState.maySendStateEvent(onboardingEvent, me) && (!room.currentState.getStateEvents(rolesEvent, '') || policy && effectiveRolePermissions(policy, me).has('manage_server'))); }
export async function saveServerOnboarding(serverId: string, value: ServerOnboarding, previous: ServerOnboarding) {
  const client = getMatrixClient(); if (!client || !canManageOnboarding(serverId)) throw new Error('You cannot manage this server’s welcome setup.');
  let current: unknown; try { current = await client.getStateEvent(serverId, onboardingEvent as any, ''); } catch (e: any) { if (e.errcode !== 'M_NOT_FOUND') throw e; }
  if (JSON.stringify(normalizeServerOnboarding(current)) !== JSON.stringify(previous)) throw new Error('Welcome settings changed on another device. Reload them before saving.');
  const next = normalizeServerOnboarding(value), allowed = new Set(serverChannelIds(serverId));
  if ([next.startChannel, ...next.recommended, ...next.interests.flatMap(interest => interest.channels)].some(id => id && !allowed.has(id))) throw new Error('Choose channels that still belong to this server.');
  await client.sendStateEvent(serverId, onboardingEvent as any, next, ''); return next;
}
export function recommendedChannels(config: ServerOnboarding, interests: string[]) { return [...new Set([config.startChannel, ...config.recommended, ...config.interests.filter(item => interests.includes(item.id)).flatMap(item => item.channels)])].filter(Boolean); }
