import { accountArtworkOwner, requestApi } from './api';
import { getMatrixClient } from './matrix';
import { parseRolePolicy, rolesEvent, type ChannelAudience } from './roles';

type NativeEvent = { type: string; state_key: string; sender?: string; event_id?: string; content: Record<string, any> };
const same = (a: ChannelAudience | null | undefined, b: ChannelAudience | null | undefined) => JSON.stringify(a ? [[...a.roleIds].sort(), [...a.userIds].sort()] : null) === JSON.stringify(b ? [[...b.roleIds].sort(), [...b.userIds].sort()] : null);
const value = (events: NativeEvent[], type: string, key = '') => events.find(event => event.type === type && event.state_key === key)?.content || {};
function nativePower(events: NativeEvent[], actor: string) {
  const creation = events.find(event => event.type === 'm.room.create' && event.state_key === ''), powers = value(events, 'm.room.power_levels');
  if (creation?.content.room_version === '12' && creation.sender === actor) return Infinity;
  return powers.users?.[actor] ?? powers.users_default ?? (events.some(event => event.type === 'm.room.power_levels') ? 0 : creation?.sender === actor ? 100 : 0);
}

export async function channelAdmissionAvailable() {
  const response = await requestApi('/channels/admission/capability');
  return response.version === 1 && response.available === true;
}

/** Save an audience and its native join rule without joining anyone or changing keys. */
export async function saveChannelAudience(serverId: string, roomId: string, audience: ChannelAudience | null, previous: ChannelAudience | null) {
  const client = getMatrixClient(), actor = client?.getUserId(), device = client?.getDeviceId(), account = accountArtworkOwner();
  const server = client?.getRoom(serverId), room = client?.getRoom(roomId);
  const current = () => {
    if (!client || !actor || client !== getMatrixClient() || client.getUserId() !== actor || client.getDeviceId() !== device || accountArtworkOwner() !== account
      || client.getRoom(serverId) !== server || room && client.getRoom(roomId) !== room || !server?.isSpaceRoom() || server.getMyMembership() !== 'join')
      throw new Error('Your account or channel membership changed. Reopen channel access.');
  };
  current();
  const desired = audience ? { roleIds: [...audience.roleIds], userIds: [...audience.userIds] } : null;
  async function read(id: string): Promise<NativeEvent[]> {
    current(); const events = await client!.roomState(id); current();
    if (!Array.isArray(events) || events.length > 10000 || events.some(event => !event || typeof event.type !== 'string' || typeof event.state_key !== 'string' || !event.content || typeof event.content !== 'object' || Array.isArray(event.content))) throw new Error('The native channel state could not be checked.');
    if (new Set(events.map(event => JSON.stringify([event.type, event.state_key]))).size !== events.length) throw new Error('The native channel state is ambiguous.');
    return events;
  }
  async function scope() {
    const parent = await read(serverId), child = await read(roomId), policy = parseRolePolicy(value(parent, rolesEvent));
    const creation = parent.find(event => event.type === 'm.room.create' && event.state_key === ''), childCreate = child.find(event => event.type === 'm.room.create' && event.state_key === '');
    const powers = value(child, 'm.room.power_levels'), threshold = powers.events?.['m.room.join_rules'] ?? powers.state_default ?? 50;
    const level = nativePower(child, actor!), parentLevel = nativePower(parent, actor!), parentPowers = value(parent, 'm.room.power_levels'), parentThreshold = parentPowers.events?.[rolesEvent] ?? parentPowers.state_default ?? 50;
    if (!policy || policy.owner !== actor || creation?.sender !== actor || creation.content.type !== 'm.space' || creation.content['m.federate'] !== false
      || value(parent, 'm.room.member', actor).membership !== 'join' || value(child, 'm.room.member', actor).membership !== 'join'
      || childCreate?.content.type || childCreate?.content['m.federate'] !== false || value(child, 'm.room.encryption').algorithm !== 'm.megolm.v1.aes-sha2'
      || value(child, 'm.space.parent', serverId).canonical !== true || !value(child, 'm.space.parent', serverId).via?.length || !value(parent, 'm.space.child', roomId).via?.length
      || !Number.isInteger(threshold) || !(Number.isInteger(level) || level === Infinity) || level < threshold
      || !Number.isInteger(parentThreshold) || !(Number.isInteger(parentLevel) || parentLevel === Infinity) || parentLevel < parentThreshold)
      throw new Error('Only the server owner with native channel authority can manage this private audience.');
    const revision = parent.find(event => event.type === rolesEvent && event.state_key === '')?.event_id;
    if (typeof revision !== 'string' || !revision.startsWith('$')) throw new Error('The current server-role revision is unavailable.');
    return { parent, child, policy, revision };
  }
  if (!await channelAdmissionAvailable()) throw new Error('Private-channel access is not ready. Ask the administrator to update and restart Synapse.');
  current(); let observed = await scope();
  if (!same(observed.policy.channelAdmissions?.[roomId], previous) && !same(observed.policy.channelAdmissions?.[roomId], desired)) throw new Error('This private audience changed elsewhere. Reload channel access.');
  if (desired && !parseRolePolicy({ ...observed.policy, channelAdmissionVersion: 1, channelAdmissions: { ...observed.policy.channelAdmissions, [roomId]: desired } })) throw new Error('Choose valid, distinct roles and members. Remove deleted roles from this audience first.');
  // Close native joins before removing an audience. Enabling starts from a
  // closed channel, so a partial setup can never create a public room.
  if (!desired || !observed.policy.channelAdmissions?.[roomId]) {
    if (value(observed.child, 'm.room.join_rules').join_rule !== 'invite') {
      current(); await client!.sendStateEvent(roomId, 'm.room.join_rules' as any, { join_rule: 'invite' }, ''); current();
    }
  }
  observed = await scope();
  if (!same(observed.policy.channelAdmissions?.[roomId], previous) && !same(observed.policy.channelAdmissions?.[roomId], desired)) throw new Error('The audience changed during setup. Reload channel access.');
  if (!same(observed.policy.channelAdmissions?.[roomId], desired)) {
    const audiences = { ...observed.policy.channelAdmissions };
    if (desired) audiences[roomId] = desired; else delete audiences[roomId];
    current(); await client!.sendStateEvent(serverId, rolesEvent as any, { ...observed.policy, channelAdmissionVersion: 1, channelAdmissions: audiences, 'io.tavern.previous_event': observed.revision }, ''); current();
  }
  observed = await scope();
  if (!same(observed.policy.channelAdmissions?.[roomId], desired)) throw new Error('The audience save was not confirmed. Reload channel access before retrying.');
  if (desired) {
    const parents: string[] = [];
    for (const event of observed.child) if (event.type === 'm.space.parent' && event.content.canonical === true && event.content.via?.length) {
      const state = event.state_key === serverId ? observed.parent : await read(event.state_key);
      const policy = parseRolePolicy(value(state, rolesEvent));
      if (policy?.channelAdmissions?.[roomId] && value(state, 'm.space.child', roomId).via?.length) parents.push(event.state_key);
    }
    current(); await client!.sendStateEvent(roomId, 'm.room.join_rules' as any, { join_rule: 'restricted', allow: parents.sort().map(room_id => ({ type: 'm.room_membership', room_id })) }, ''); current();
  }
  const final = await scope();
  if (!same(final.policy.channelAdmissions?.[roomId], desired) || value(final.child, 'm.room.join_rules').join_rule !== (desired ? 'restricted' : 'invite')) throw new Error('Channel access needs another check. Reload its saved settings.');
}
