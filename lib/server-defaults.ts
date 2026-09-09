import { getMatrixClient } from './matrix';
import { canEditConversationState, checkedConversationState } from './channel-administration';
import { normalizeNotificationDefault, notificationDefaultsEvent, type NotificationDefault } from './notification-preferences';
import { defaultRolePolicy, rolesEvent } from './roles';

export function readRoomNotificationDefault(roomId: string) { return normalizeNotificationDefault(getMatrixClient()?.getRoom(roomId)?.currentState.getStateEvents(notificationDefaultsEvent, '')?.getContent()); }
export function canEditNotificationDefault(roomId: string) { return canEditConversationState(roomId, notificationDefaultsEvent); }
export async function saveRoomNotificationDefault(roomId: string, value: NotificationDefault, previous: NotificationDefault) {
  const client = await checkedConversationState(roomId, notificationDefaultsEvent);
  const state = await client.roomState(roomId);
  if (!Array.isArray(state) || state.length > 50000) throw new Error('Notification defaults could not be safely checked.');
  const event = state.find(event => event.type === notificationDefaultsEvent && event.state_key === '');
  if (JSON.stringify(normalizeNotificationDefault(event?.content)) !== JSON.stringify(previous)) throw new Error('Notification defaults changed. Reload them before saving.');
  const checked = await checkedConversationState(roomId, notificationDefaultsEvent);
  if (checked !== client) throw new Error('Your account changed. Reopen these settings.');
  const next = normalizeNotificationDefault(value);
  await client.sendStateEvent(roomId, notificationDefaultsEvent as any, { ...next, 'io.tavern.previous_event': event?.event_id ?? null }, '');
  return next;
}

export function serverCreationState(owner: string, options: { notificationMode?: unknown; welcome?: unknown; welcomeEnabled?: unknown }, rolePolicyEnabled: boolean) {
  const welcome = typeof options.welcome === 'string' ? options.welcome.trim().slice(0, 2000) : '';
  return [
    { type: notificationDefaultsEvent, state_key: '', content: normalizeNotificationDefault({ mode: options.notificationMode ?? 'mentions' }) },
    { type: 'io.tavern.server.branding', state_key: '', content: { welcome } },
    { type: 'io.tavern.server.onboarding', state_key: '', content: { version: 1, enabled: options.welcomeEnabled === true, startChannel: '', welcomeChannel: '', rulesChannel: '', announcementChannel: '', recommended: [], interests: [] } },
    ...(rolePolicyEnabled ? [{ type: rolesEvent, state_key: '', content: defaultRolePolicy(owner) }] : []),
  ];
}
