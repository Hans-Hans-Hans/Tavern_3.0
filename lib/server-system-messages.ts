import { accountArtworkOwner, isManagedAccount, requestApi } from './api';
import { getMatrixClient } from './matrix';
import { canEditConversationState } from './channel-administration';

export const serverSystemMessagesEvent = 'io.tavern.server.system_messages';
export type SystemMessageSettings = { version: 1; enabled: boolean; channelId: string; hookId: string; joins: boolean; leaves: boolean; 'io.tavern.previous_event': string | null };
export type SystemMessageDestination = { hookId: string; roomId: string; name: string };
export type ServerSystemMessages = { enabled: boolean; ready: boolean; settings: SystemMessageSettings | null; eventId: string | null; destinations: SystemMessageDestination[]; counts: { pending: number; sent: number; cancelled: number }; configurationRevision: string };
export const emptySystemMessageSettings = (): SystemMessageSettings => ({ version: 1, enabled: false, channelId: '', hookId: '', joins: true, leaves: false, 'io.tavern.previous_event': null });
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown, prefix: string): value is string => typeof value === 'string' && value.startsWith(prefix) && value.length >= 2 && value.length <= 511 && !/[\s\x00-\x1f\x7f]/.test(value);
const hookId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/.test(value);
const revision = (value: unknown): value is string | null => value === null || identity(value, '$');

export function parseSystemMessageSettings(value: unknown): SystemMessageSettings | null {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'channelId,enabled,hookId,io.tavern.previous_event,joins,leaves,version'
    || value.version !== 1 || ['enabled', 'joins', 'leaves'].some(key => typeof value[key] !== 'boolean') || !revision(value['io.tavern.previous_event'])
    || !(identity(value.channelId, '!') || !value.enabled && value.channelId === '') || !(hookId(value.hookId) || !value.enabled && value.hookId === '')
    || value.enabled && !value.joins && !value.leaves) return null;
  return { version: 1, enabled: value.enabled, channelId: value.channelId, hookId: value.hookId, joins: value.joins, leaves: value.leaves, 'io.tavern.previous_event': value['io.tavern.previous_event'] };
}
export function parseServerSystemMessages(value: unknown): ServerSystemMessages {
  const invalid = () => { throw new Error('The server returned incomplete system notice settings. Reload before editing.'); };
  if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.ready !== 'boolean' || !revision(value.eventId)
    || typeof value.configurationRevision !== 'string' || value.configurationRevision.length > 256 || /[\x00-\x1f\x7f]/.test(value.configurationRevision)
    || !Array.isArray(value.destinations) || value.destinations.length > 1000 || !record(value.counts)) return invalid();
  const settings = value.settings === null ? null : parseSystemMessageSettings(value.settings);
  if ((value.settings !== null && !settings) || (settings === null) !== (value.eventId === null)) return invalid();
  const destinations: SystemMessageDestination[] = [], seen = new Set<string>();
  for (const option of value.destinations) {
    if (!record(option) || !hookId(option.hookId) || !identity(option.roomId, '!') || typeof option.name !== 'string' || !option.name.trim() || option.name.length > 80 || /[\x00-\x1f\x7f]/.test(option.name) || seen.has(option.hookId)) return invalid();
    seen.add(option.hookId); destinations.push({ hookId: option.hookId, roomId: option.roomId, name: option.name });
  }
  const counts = { pending: 0, sent: 0, cancelled: 0 };
  for (const [key, count] of Object.entries(value.counts)) {
    if (!Object.hasOwn(counts, key) || !Number.isSafeInteger(count) || (count as number) < 0) return invalid();
    counts[key as keyof typeof counts] = count as number;
  }
  return { enabled: value.enabled, ready: value.ready, eventId: value.eventId, settings, destinations, counts, configurationRevision: value.configurationRevision };
}
export function canManageServerSystemMessages(serverId: string) {
  try {
    const client = getMatrixClient(), room = client?.getRoom(serverId), creation = room?.currentState.getStateEvents('m.room.create', '');
    if (!isManagedAccount() || !identity(serverId, '!') || !room?.isSpaceRoom() || creation?.getContent()['m.federate'] !== false) return false;
    if (!room.currentState.getStateEvents('io.tavern.roles' as any, '') && creation.getSender() !== client?.getUserId()) return false;
    return canEditConversationState(serverId, serverSystemMessagesEvent);
  } catch { return false; }
}
function scope(serverId: string) {
  const client = getMatrixClient(), actor = client?.getUserId(), account = accountArtworkOwner();
  const current = () => {
    if (!client || !actor || getMatrixClient() !== client || client.getUserId() !== actor || accountArtworkOwner() !== account || !canManageServerSystemMessages(serverId)) throw new Error('Your account or native server authority changed. Reload these settings.');
  };
  current(); return { current, path: '/servers/' + encodeURIComponent(serverId) + '/system-messages' };
}
export async function loadServerSystemMessages(serverId: string): Promise<ServerSystemMessages> {
  const owner = scope(serverId), response = await requestApi(owner.path); owner.current(); return parseServerSystemMessages(response);
}
export function systemMessagesDraftError(settings: SystemMessageSettings, previous: ServerSystemMessages): string | null {
  if (!parseSystemMessageSettings(settings)) return 'Choose a destination and at least one membership notice when enabling system notices.';
  if (settings.enabled && (!previous.enabled || !previous.ready)) return 'Provision the encrypted bot before enabling system notices.';
  if (settings.enabled && !previous.destinations.some(destination => destination.hookId === settings.hookId && destination.roomId === settings.channelId)) return 'Choose an available encrypted webhook destination.';
  return null;
}
export async function saveServerSystemMessages(serverId: string, draft: SystemMessageSettings, previous: ServerSystemMessages, confirmation: string) {
  const owner = scope(serverId);
  if (confirmation !== serverId) throw new Error('Type the exact server ID to confirm these system notice settings.');
  const initialError = systemMessagesDraftError(draft, previous); if (initialError) throw new Error(initialError);
  const response = await requestApi(owner.path); owner.current(); const fresh = parseServerSystemMessages(response);
  if (fresh.eventId !== previous.eventId) throw new Error('System notice settings changed. Your draft is preserved. Reload before saving.');
  if (fresh.configurationRevision !== previous.configurationRevision) throw new Error('The encrypted webhook configuration changed. Your draft is preserved. Reload the destinations before saving.');
  const error = systemMessagesDraftError(draft, fresh); if (error) throw new Error(error);
  const settings = { ...draft, 'io.tavern.previous_event': fresh.eventId }; owner.current();
  const result = await requestApi(owner.path, { settings, confirmation }, 'PUT'); owner.current();
  if (!record(result) || !identity(result.eventId, '$')) throw new Error('The homeserver did not confirm the saved settings. Reload before retrying.');
  return { ...fresh, settings, eventId: result.eventId };
}
