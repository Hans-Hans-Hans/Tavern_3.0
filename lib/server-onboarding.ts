import { getMatrixClient } from './matrix';
import { serverChannelIds } from './community';
import { canEditConversationState, checkedConversationState } from './channel-administration';
export const onboardingEvent = 'io.tavern.server.onboarding';
export type ServerOnboarding = { version: 1; enabled: boolean; startChannel: string; welcomeChannel: string; rulesChannel: string; announcementChannel: string; recommended: string[]; interests: { id: string; label: string; channels: string[] }[] };
export function normalizeServerOnboarding(value: any): ServerOnboarding {
  const channels = (items: unknown) => [...new Set(Array.isArray(items) ? items.filter(id => typeof id === 'string' && id.startsWith('!') && id.length <= 255) : [])].slice(0, 20) as string[];
  const used = new Set<string>();
  return { version: 1, enabled: value?.enabled === true, startChannel: channels([value?.startChannel])[0] || '', welcomeChannel: channels([value?.welcomeChannel])[0] || '', rulesChannel: channels([value?.rulesChannel])[0] || '', announcementChannel: channels([value?.announcementChannel])[0] || '', recommended: channels(value?.recommended), interests: (Array.isArray(value?.interests) ? value.interests : []).slice(0, 12).flatMap((item: any) => { if (!item || typeof item.id !== 'string' || !/^[\w-]{1,80}$/.test(item.id) || used.has(item.id) || typeof item.label !== 'string' || !item.label.trim()) return []; used.add(item.id); return [{ id: item.id, label: item.label.trim().slice(0, 80), channels: channels(item.channels) }]; }) };
}
export function readServerOnboarding(serverId: string) { return normalizeServerOnboarding(getMatrixClient()?.getRoom(serverId)?.currentState.getStateEvents(onboardingEvent, '')?.getContent()); }
export function canManageOnboarding(serverId: string) { return !!getMatrixClient()?.getRoom(serverId)?.isSpaceRoom() && canEditConversationState(serverId, onboardingEvent); }
export async function saveServerOnboarding(serverId: string, value: ServerOnboarding, previous: ServerOnboarding) {
  if (!canManageOnboarding(serverId)) throw new Error('You cannot manage this server’s welcome setup.');
  const client = await checkedConversationState(serverId, onboardingEvent), state = await client.roomState(serverId);
  if (!Array.isArray(state) || state.length > 50000) throw new Error('Server settings could not be safely checked.');
  const current = state.find(event => event.type === onboardingEvent && event.state_key === '');
  if (JSON.stringify(normalizeServerOnboarding(current?.content)) !== JSON.stringify(previous)) throw new Error('Welcome settings changed on another device. Reload them before saving.');
  const next = normalizeServerOnboarding(value), allowed = new Set(serverChannelIds(serverId));
  if ([next.startChannel, next.welcomeChannel, next.rulesChannel, next.announcementChannel, ...next.recommended, ...next.interests.flatMap(interest => interest.channels)].some(id => id && !allowed.has(id))) throw new Error('Choose channels that still belong to this server.');
  const checked = await checkedConversationState(serverId, onboardingEvent);
  if (checked !== client || !canManageOnboarding(serverId)) throw new Error('Your account or server permissions changed.');
  await client.sendStateEvent(serverId, onboardingEvent as any, { ...next, 'io.tavern.previous_event': current?.event_id ?? null }, ''); return next;
}
export function recommendedChannels(config: ServerOnboarding, interests: string[]) { return [...new Set([config.startChannel, ...config.recommended, ...config.interests.filter(item => interests.includes(item.id)).flatMap(item => item.channels)])].filter(Boolean); }
