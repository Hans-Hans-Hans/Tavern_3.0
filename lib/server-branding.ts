import { getMatrixClient } from './matrix';
import { canEditConversationState, checkedConversationState } from './channel-administration';
import { invitationSplashMxc } from './invitation-artwork';

export const serverBrandingEvent = 'io.tavern.server.branding';
const types = [serverBrandingEvent, 'm.room.name', 'm.room.topic', 'm.room.avatar'];
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '';
const mxc = (value: unknown) => typeof value === 'string' && value.length <= 1024 && /^mxc:\/\/[^\s/?#]+\/[^\s/?#]+$/.test(value) ? value : '';
function normalize(value: any) { return { banner: mxc(value?.banner), accent: typeof value?.accent === 'string' && /^#[0-9a-f]{6}$/i.test(value.accent) ? value.accent : '', welcome: clean(value?.welcome, 2000), inviteSplash: invitationSplashMxc(value?.inviteSplash) }; }
export function readServerBranding(serverId: string) {
  const room = getMatrixClient()?.getRoom(serverId), event = room?.currentState.getStateEvents(serverBrandingEvent, '');
  const state = (type: string) => room?.currentState.getStateEvents(type, '')?.getContent() || {};
  return { name: clean(state('m.room.name').name || room?.name, 60), description: clean(state('m.room.topic').topic, 1000), icon: mxc(state('m.room.avatar').url), ...normalize(event?.getContent()), revision: event?.getId() ?? null };
}
export function canEditServerBranding(serverId: string) { return !!getMatrixClient()?.getRoom(serverId)?.isSpaceRoom() && types.every(type => canEditConversationState(serverId, type)); }
export async function saveServerBranding(serverId: string, value: ReturnType<typeof readServerBranding>, previous: ReturnType<typeof readServerBranding>) {
  if (!canEditServerBranding(serverId)) throw new Error('You do not have permission to customize this server.');
  const name = clean(value.name, 60).trim(); if (!name) throw new Error('Enter a server name.');
  const client = await checkedConversationState(serverId, serverBrandingEvent), state = await client.roomState(serverId);
  if (!Array.isArray(state) || state.length > 50000) throw new Error('Server details could not be safely checked.');
  const current = state.find(event => event.type === serverBrandingEvent && event.state_key === '');
  if ((current?.event_id ?? null) !== previous.revision || JSON.stringify(normalize(current?.content)) !== JSON.stringify(normalize(previous))) throw new Error('Server branding changed. Reload server details before saving.');
  const next = { ...value, name, description: clean(value.description, 1000), icon: mxc(value.icon), ...normalize(value) };
  const native: [string, string, string, string][] = [['m.room.name', 'name', previous.name, name], ['m.room.topic', 'topic', previous.description, next.description], ['m.room.avatar', 'url', previous.icon, next.icon]];
  const changes = native.filter(([, , before, after]) => before !== after);
  const checkDetails = (events: any[], type: string, key: string, before: string) => {
    const content = events.find(event => event.type === type && event.state_key === '')?.content;
    const old = content?.[key] ?? (type === 'm.room.name' ? previous.name : '');
    if (old !== before) throw new Error('Server details changed. Reload server details before saving.');
  };
  for (const [type, key, before] of changes) checkDetails(state, type, key, before);
  const writes: [string, object][] = [[serverBrandingEvent, { ...normalize(next), 'io.tavern.previous_event': current?.event_id ?? null }], ...changes.map(([type, key, , after]): [string, object] => [type, { [key]: after }])];
  let saved = 0, revision = previous.revision;
  try {
    for (const [type, content] of writes) {
      const change = changes.find(([event]) => type === event);
      if (change) {
        const fresh = await client.roomState(serverId);
        if (!Array.isArray(fresh) || fresh.length > 50000) throw new Error('Server details could not be safely checked.');
        checkDetails(fresh, change[0], change[1], change[2]);
      }
      const checked = await checkedConversationState(serverId, type);
      if (checked !== client || !canEditServerBranding(serverId)) throw new Error('Your account or server permissions changed.');
      const response = await client.sendStateEvent(serverId, type as any, content, '');
      if (type === serverBrandingEvent) revision = response.event_id; saved++;
    }
  } catch (error) { throw new Error(`${saved ? 'Some server details were saved. ' : ''}${(error as Error).message} Reload server details and retry.`); }
  return { ...next, revision };
}
