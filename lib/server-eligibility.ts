import { getMatrixClient } from './matrix';
import { canEditConversationState, checkedConversationState } from './channel-administration';

export const serverEligibilityEvent = 'io.tavern.server.eligibility';
export const accountAgeChoices = [0, 300, 3600, 86400, 604800] as const;
export type ServerEligibility = { version: 1; requireVerifiedEmail: boolean; minimumAccountAgeSeconds: number };
export const emptyServerEligibility = (): ServerEligibility => ({ version: 1, requireVerifiedEmail: false, minimumAccountAgeSeconds: 0 });
const validRevision = (value: unknown): value is string => typeof value === 'string' && /^\$[^\s\x00-\x1f\x7f]{1,1023}$/.test(value);
export function parseServerEligibility(value: unknown): ServerEligibility | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || typeof data.requireVerifiedEmail !== 'boolean'
    || !(accountAgeChoices as readonly unknown[]).includes(data.minimumAccountAgeSeconds)
    || Object.keys(data).some(key => !['version', 'requireVerifiedEmail', 'minimumAccountAgeSeconds', 'io.tavern.previous_event'].includes(key))) return null;
  const previous = data['io.tavern.previous_event'];
  if (previous !== undefined && previous !== null && !validRevision(previous)) return null;
  return { version: 1, requireVerifiedEmail: data.requireVerifiedEmail, minimumAccountAgeSeconds: data.minimumAccountAgeSeconds as number };
}
export function readServerEligibility(serverId: string): ServerEligibility | null {
  const event = getMatrixClient()?.getRoom(serverId)?.currentState.getStateEvents(serverEligibilityEvent as any, '');
  return event ? parseServerEligibility(event.getContent()) : emptyServerEligibility();
}
export function canManageServerEligibility(serverId: string) {
  const client = getMatrixClient(), room = client?.getRoom(serverId), creation = room?.currentState.getStateEvents('m.room.create', '');
  if (!room?.currentState.getStateEvents('io.tavern.roles' as any, '') && creation?.getSender() !== client?.getUserId()) return false;
  return !!(room?.isSpaceRoom() && creation?.getContent()['m.federate'] === false
    && canEditConversationState(serverId, serverEligibilityEvent));
}
export async function saveServerEligibility(serverId: string, value: ServerEligibility, previous: ServerEligibility | null) {
  const next = parseServerEligibility(value);
  if (!next || !canManageServerEligibility(serverId)) throw new Error('Choose valid verification settings and check your server permissions.');
  const client = await checkedConversationState(serverId, serverEligibilityEvent);
  const state = await client.roomState(serverId);
  if (!Array.isArray(state) || state.length > 50000) throw new Error('Server verification settings could not be checked.');
  const observed = state.find(event => event.type === serverEligibilityEvent && event.state_key === '');
  const current = observed ? parseServerEligibility(observed.content) : emptyServerEligibility();
  if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('Verification settings changed. Reload them before saving.');
  if (observed && !validRevision(observed.event_id)) throw new Error('The saved verification revision could not be checked.');
  const checked = await checkedConversationState(serverId, serverEligibilityEvent);
  if (checked !== client || !canManageServerEligibility(serverId)) throw new Error('Your account or server permissions changed.');
  await client.sendStateEvent(serverId, serverEligibilityEvent as any, { ...next, 'io.tavern.previous_event': observed?.event_id ?? null }, '');
  return next;
}
