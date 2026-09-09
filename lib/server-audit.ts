import { Direction, Filter } from 'matrix-js-sdk';
import { getMatrixClient } from './matrix';
import { effectiveRolePermissions, readRolePolicy } from './roles';

export const auditEventTypes = ['m.room.create', 'm.room.name', 'm.room.topic', 'm.room.avatar', 'm.room.member', 'm.room.power_levels', 'm.room.join_rules', 'm.room.history_visibility', 'm.room.encryption', 'm.room.pinned_events', 'm.room.redaction', 'm.space.child', 'm.space.parent', 'io.tavern.roles', 'io.tavern.server.layout', 'io.tavern.channel', 'io.tavern.timeout', 'io.tavern.tempban', 'io.tavern.thread', 'io.tavern.server.onboarding', 'io.tavern.emoji'];
export type AuditKind = 'membership' | 'moderation' | 'roles' | 'channels' | 'settings';
export type ServerAuditEvent = { id: string; roomId: string; actor: string; target: string; at: number; kind: AuditKind; action: string; detail: string; type: string };
export type AuditFilters = { actor: string; target: string; kind: string; since: string; until: string };
const text = (value: unknown, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function projectServerAuditEvent(raw: any, roomId: string): ServerAuditEvent | null {
  if (!raw || !auditEventTypes.includes(raw.type) || !text(raw.event_id) || !text(raw.sender)) return null;
  const content = object(raw.content), previous = object(raw.unsigned?.prev_content), hasPrevious = !!raw.unsigned?.prev_content;
  const result: ServerAuditEvent = { id: text(raw.event_id, 1024), roomId, actor: text(raw.sender, 255), target: text(raw.state_key, 255) || roomId, at: typeof raw.origin_server_ts === 'number' && Number.isFinite(raw.origin_server_ts) ? raw.origin_server_ts : 0, kind: 'settings', action: 'Updated room settings', detail: '', type: raw.type };
  if (raw.unsigned?.redacted_because) return { ...result, action: 'Redacted audit event', detail: 'Original event details are no longer available.' };
  switch (raw.type) {
    case 'm.room.member': {
      result.kind = 'membership';
      const membership = content.membership, changedByOther = result.actor !== result.target;
      if (membership === 'ban') { result.action = 'Banned member'; result.kind = 'moderation'; }
      else if (membership === 'leave' && previous.membership === 'ban') { result.action = 'Lifted member ban'; result.kind = 'moderation'; }
      else if (membership === 'leave' && changedByOther) { result.action = 'Removed member or invitation'; result.kind = 'moderation'; }
      else if (membership === 'leave') result.action = 'Left room or declined invitation';
      else if (membership === 'invite') result.action = 'Invited member';
      else if (membership === 'join') result.action = hasPrevious && previous.membership === 'join' ? 'Updated member profile' : 'Joined or updated membership';
      else if (membership === 'knock') result.action = 'Requested to join';
      else return null;
      result.detail = text(content.reason); break;
    }
    case 'm.room.redaction': result.kind = 'moderation'; result.action = 'Redacted event'; result.target = text(content.redacts || raw.redacts, 1024) || 'Unavailable event ID'; result.detail = text(content.reason); break;
    case 'io.tavern.timeout': result.kind = 'moderation'; result.action = Number.isSafeInteger(content.until) && content.until > result.at && content.until <= 8640000000000000 ? 'Timed out member' : 'Removed member timeout'; result.detail = (Number.isSafeInteger(content.until) && content.until > result.at && content.until <= 8640000000000000 ? 'Until ' + new Date(content.until).toISOString() + '. ' : '') + text(content.reason); break;
    case 'io.tavern.tempban': {
      result.kind = 'moderation'; const until = content.until;
      const valid = content.version === 1 && Number.isSafeInteger(until) && until >= 0 && until <= 8640000000000000;
      result.action = !valid ? 'Temporary ban with invalid expiry' : until === 0 ? 'Lifted temporary ban' : 'Applied temporary ban';
      result.detail = (!valid ? 'Restriction remains active until repaired. ' : until ? 'Until ' + new Date(until).toISOString() + '. ' : '') + text(content.reason); break;
    }
    case 'io.tavern.roles': {
      result.kind = 'roles'; result.action = 'Updated server roles and permissions';
      const roles = Array.isArray(content.roles) ? content.roles.slice(0, 100) : [], old = Array.isArray(previous.roles) ? previous.roles.slice(0, 100) : [];
      const named = (items: any[]) => items.map(role => text(role?.name, 60)).filter(Boolean).slice(0, 6).join(', ');
      const added = hasPrevious ? roles.filter(role => !old.some(before => before?.id === role?.id)) : [], removed = hasPrevious ? old.filter(role => !roles.some(after => after?.id === role?.id)) : [];
      result.detail = [added.length ? 'Added: ' + named(added) : '', removed.length ? 'Removed: ' + named(removed) : '', roles.length + ' roles; ' + Object.keys(object(content.members)).length + ' explicit member assignments'].filter(Boolean).join('. '); break;
    }
    case 'm.room.power_levels': result.kind = 'roles'; result.action = 'Updated native room permissions'; result.detail = Object.keys(object(content.users)).length + ' explicit user power levels'; break;
    case 'io.tavern.server.layout': result.kind = 'channels'; result.action = 'Updated categories and channel order'; result.detail = (Array.isArray(content.categories) ? content.categories.length : 0) + ' categories; ' + (Array.isArray(content.channels) ? content.channels.length : 0) + ' channels'; break;
    case 'm.space.child': result.kind = 'channels'; result.action = Array.isArray(content.via) && content.via.length ? 'Linked channel to server' : 'Removed channel link'; break;
    case 'm.space.parent': result.kind = 'channels'; result.action = Array.isArray(content.via) && content.via.length ? 'Linked parent server' : 'Removed parent server link'; break;
    case 'io.tavern.channel': result.kind = 'channels'; result.action = 'Updated channel behavior and appearance'; result.detail = [typeof content.archived === 'boolean' ? content.archived ? 'Archived' : 'Unarchived' : '', text(content.kind, 30), Number.isInteger(content.slowModeSeconds) ? 'Slow mode: ' + content.slowModeSeconds + ' seconds' : ''].filter(Boolean).join(' · '); break;
    case 'io.tavern.thread': result.kind = 'moderation'; result.action = 'Updated thread settings'; result.detail = [content.locked === true ? 'Locked' : '', content.closed === true ? 'Closed' : '', content.archived === true ? 'Archived' : '', text(content.title, 160)].filter(Boolean).join(' · '); break;
    case 'm.room.name': result.action = 'Changed room name'; result.detail = text(content.name, 255); break;
    case 'm.room.topic': result.action = 'Changed room topic'; result.detail = text(content.topic); break;
    case 'm.room.avatar': result.action = 'Changed room picture'; break;
    case 'm.room.create': result.action = 'Created ' + (content.type === 'm.space' ? 'server' : 'room'); break;
    case 'm.room.join_rules': result.action = 'Changed join rules'; result.detail = text(content.join_rule, 80); break;
    case 'm.room.history_visibility': result.action = 'Changed history visibility'; result.detail = text(content.history_visibility, 80); break;
    case 'm.room.encryption': result.action = 'Enabled room encryption'; result.detail = text(content.algorithm, 80); break;
    case 'm.room.pinned_events': result.action = 'Changed pinned messages'; result.detail = (Array.isArray(content.pinned) ? content.pinned.length : 0) + ' pinned events'; break;
    case 'io.tavern.server.onboarding': result.action = 'Updated server welcome experience'; break;
    case 'io.tavern.emoji': result.action = 'Updated server emojis'; break;
  }
  return result;
}

export function filterServerAudit(events: ServerAuditEvent[], filters: AuditFilters) {
  const since = filters.since ? Date.parse(filters.since) : -Infinity, until = filters.until ? Date.parse(filters.until) : Infinity;
  return events.filter(event => (!filters.actor.trim() || event.actor === filters.actor.trim()) && (!filters.target.trim() || event.target.toLocaleLowerCase().includes(filters.target.trim().toLocaleLowerCase())) && (filters.kind === 'all' || event.kind === filters.kind) && event.at >= since && event.at <= until);
}
export function canViewServerAudit(serverId: string) {
  const client = getMatrixClient(), server = client?.getRoom(serverId), me = client?.getUserId();
  if (!client || !server?.isSpaceRoom() || server.getMyMembership() !== 'join' || !me) return false;
  const nativePower = server.getMember(me)?.powerLevel || 0, policyEvent = server.currentState.getStateEvents('io.tavern.roles', ''), policy = readRolePolicy(serverId);
  if (policyEvent && !policy) return false;
  return nativePower >= 50 && (!policy || ['manage_server', 'manage_roles', 'manage_channels', 'manage_messages', 'kick', 'ban', 'timeout'].some(permission => effectiveRolePermissions(policy, me).has(permission as any)));
}
export function serverAuditRooms(serverId: string) {
  const client = getMatrixClient(), server = client?.getRoom(serverId);
  if (!client || !server || !canViewServerAudit(serverId)) return [];
  const result = [{ id: serverId, name: server.name + ' (server)' }];
  for (const event of server.currentState.getStateEvents('m.space.child').slice(0, 1000)) {
    const id = event.getStateKey(), room = id ? client.getRoom(id) : null, parent = room?.currentState.getStateEvents('m.space.parent', serverId)?.getContent();
    if (id && event.getContent().via?.length && room?.getMyMembership() === 'join' && parent?.canonical && parent.via?.length) result.push({ id, name: room.name });
  }
  return result;
}
export async function loadServerAuditPage(serverId: string, roomId: string, from: string | null = null) {
  const client = getMatrixClient();
  if (!client || !canViewServerAudit(serverId) || !serverAuditRooms(serverId).some(room => room.id === roomId)) throw new Error('Choose a joined server or channel you can administer.');
  const filter = new Filter(client.getUserId()!); filter.setDefinition({ room: { timeline: { types: auditEventTypes } } });
  const page = await client.createMessagesRequest(roomId, from, 50, Direction.Backward, filter);
  if (client !== getMatrixClient() || !canViewServerAudit(serverId) || client.getRoom(roomId)?.getMyMembership() !== 'join') throw new Error('Your access changed while loading history.');
  const events = page.chunk.slice(0, 50).map(raw => projectServerAuditEvent(raw, roomId)).filter((event): event is ServerAuditEvent => !!event).sort((a, b) => b.at - a.at);
  return { events, next: page.end && page.end !== from ? page.end : null };
}
