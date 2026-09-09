import type { MatrixClient, Room } from 'matrix-js-sdk';
import { accountArtworkOwner } from './api';
import { isPrivateDiscussion } from './conversation-routing';
import { blockUser } from './interactions';
import { getMatrixClient, mutateMatrixAccountData } from './matrix';

export type DmRequest = { roomId: string; inviter: string; name: string; joined: boolean; blocked: boolean; encrypted: boolean; publicRoom: boolean };
export type DmRequestResult = { status: 'accepted' | 'declined' | 'blocked' | 'partial'; roomId: string; message: string };
type Pending = { inviter: string; name: string; stamp: string };
type State = { account: object; ignoredEvent: unknown; repairs: Map<string, Pending>; dismissed: Map<string, string>; blocked: Set<string>; busy: Set<string> };
type Scope = { client: MatrixClient; account: object; actor: string; stamp: string };
const states = new WeakMap<MatrixClient, State>(), scopes = new WeakMap<DmRequest, Scope>();
const identity = (value: unknown, prefix: string): value is string => typeof value === 'string' && value.startsWith(prefix) && value.length > 2 && value.length <= 511 && !/[\s\x00-\x1f\x7f]/.test(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(x => typeof x === 'string') : [];
const direct = (client: MatrixClient, roomId: string) => Object.values(client.getAccountData('m.direct' as any)?.getContent() || {}).some(ids => strings(ids).includes(roomId));
function state(client: MatrixClient): State {
  const account = accountArtworkOwner(), ignoredEvent = client.getAccountData('m.ignored_user_list' as any); let value = states.get(client);
  if (!value || value.account !== account) { value = { account, ignoredEvent, repairs: new Map(), dismissed: new Map(), blocked: new Set(), busy: new Set() }; states.set(client, value); }
  // Cover the gap before managed block results sync, then let the native ignore
  // event govern future unblocks from Contacts or another device.
  if (value.ignoredEvent !== ignoredEvent) { value.blocked.clear(); value.ignoredEvent = ignoredEvent; }
  return value;
}
function marker(room: Room, actor: string, joined = false) {
  if (room.isSpaceRoom() || isPrivateDiscussion(room)) return null;
  const event = room.currentState.getStateEvents('m.room.member', actor);
  if (!event) return null;
  const content = joined ? event.getPrevContent() : event.getContent(), sender = joined ? event.getUnsigned().prev_sender : event.getSender();
  if (content.membership !== 'invite' || content.is_direct !== true || !identity(sender, '@') || sender === actor) return null;
  return { inviter: sender, stamp: JSON.stringify([event.getId() || '', sender, content]) };
}
/** An inviter-supplied label for the inbox, never an authorization or membership rule. */
export function isDmRequest(room: Room | null | undefined): boolean {
  const client = getMatrixClient(), actor = client?.getUserId();
  return !!client && !!actor && !!room && room.getMyMembership() === 'invite' && !!marker(room, actor);
}
export function dmRequests(): DmRequest[] {
  const client = getMatrixClient(), actor = client?.getUserId(); if (!client || !actor) return [];
  const own = state(client), rows: DmRequest[] = [];
  for (const room of client.getRooms()) {
    if (!identity(room.roomId, '!') || room.isSpaceRoom() || isPrivateDiscussion(room)) continue;
    const membership = room.getMyMembership(); let repair = own.repairs.get(room.roomId);
    if (membership !== 'invite' && membership !== 'join') { own.repairs.delete(room.roomId); continue; }
    if (membership === 'join' && direct(client, room.roomId)) { own.repairs.delete(room.roomId); continue; }
    const invitation = marker(room, actor, membership === 'join');
    if (repair && membership === 'invite' && invitation?.stamp !== repair.stamp) { own.repairs.delete(room.roomId); repair = undefined; }
    if (!repair && !invitation) continue;
    const stamp = invitation?.stamp || '', inviter = repair?.inviter || invitation!.inviter;
    if (own.dismissed.get(room.roomId) === stamp && !repair) continue;
    const request: DmRequest = { roomId: room.roomId, inviter, name: (repair?.name || room.name || room.roomId).slice(0, 200), joined: !!repair || membership === 'join', blocked: own.blocked.has(inviter) || client.getIgnoredUsers().includes(inviter), encrypted: room.currentState.getStateEvents('m.room.encryption', '')?.getContent().algorithm === 'm.megolm.v1.aes-sha2', publicRoom: room.getJoinRule() === 'public' };
    scopes.set(request, { client, actor, account: own.account, stamp }); rows.push(request);
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.roomId.localeCompare(b.roomId));
}
function scope(request: DmRequest) {
  const captured = scopes.get(request);
  if (!captured) throw new Error('Reload the message request before continuing.');
  const { client, actor, account } = captured, own = state(client);
  const current = () => { if (getMatrixClient() !== client || client.getUserId() !== actor || accountArtworkOwner() !== account) throw new Error('Your account changed. Reopen the message requests.'); };
  const room = () => { current(); const value = client.getRoom(request.roomId); if (!value || value.isSpaceRoom() || isPrivateDiscussion(value)) throw new Error('This message request is no longer available.'); return value; };
  const invited = () => {
    const value = room(), invitation = marker(value, actor);
    if (value.getMyMembership() !== 'invite' || !invitation || invitation.inviter !== request.inviter || invitation.stamp !== captured.stamp) throw new Error('This invitation changed or was withdrawn. Reload the message requests.');
    return value;
  };
  const unblocked = () => { current(); if (own.blocked.has(request.inviter) || client.getIgnoredUsers().includes(request.inviter)) throw new Error('This user is blocked. Unblock them in Contacts before accepting.'); };
  current(); return { client, own, current, room, invited, unblocked };
}
async function operate(request: DmRequest, operation: (owner: ReturnType<typeof scope>) => Promise<DmRequestResult>) {
  const owner = scope(request);
  if (owner.own.busy.has(request.roomId)) throw new Error('A request action is already in progress.');
  owner.own.busy.add(request.roomId);
  try { return await operation(owner); } finally { owner.own.busy.delete(request.roomId); }
}
export function acceptDmRequest(request: DmRequest): Promise<DmRequestResult> {
  return operate(request, async owner => {
    owner.unblocked();
    if (!request.joined) {
      owner.invited(); await owner.client.joinRoom(request.roomId); owner.current();
      owner.own.repairs.set(request.roomId, { inviter: request.inviter, name: request.name, stamp: scopes.get(request)!.stamp });
    }
    const joined = () => { owner.unblocked(); if (owner.room().getMyMembership() !== 'join') throw new Error('Waiting for joined room state to sync. Retry adding to Messages when connected.'); };
    try {
      joined();
      await mutateMatrixAccountData(owner.client, 'm.direct', previous => {
        if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('Your Messages list is invalid. It has been kept unchanged.');
        return { ...previous, [request.inviter]: [...new Set([...strings(previous[request.inviter]), request.roomId])] };
      }, joined);
      joined();
      if (!direct(owner.client, request.roomId)) throw new Error('The Messages list has not synced yet or changed on another device. Retry adding this room.');
      owner.own.repairs.delete(request.roomId);
      return { status: 'accepted', roomId: request.roomId, message: 'Request accepted and added to Messages.' };
    } catch (error) {
      owner.current();
      return { status: 'partial', roomId: request.roomId, message: 'You joined the room, but it has not been added to Messages. ' + (error as Error).message };
    }
  });
}
export function declineDmRequest(request: DmRequest): Promise<DmRequestResult> {
  return operate(request, async owner => {
    if (request.joined) throw new Error('This room was already joined. Leave it from the conversation menu.');
    owner.invited(); await owner.client.leave(request.roomId); owner.current();
    owner.own.dismissed.set(request.roomId, scopes.get(request)!.stamp);
    return { status: 'declined', roomId: request.roomId, message: 'Message request declined.' };
  });
}
export function blockDmRequest(request: DmRequest): Promise<DmRequestResult> {
  return operate(request, async owner => {
    if (request.joined) throw new Error('Use Contacts to block someone after joining a room.');
    owner.invited(); await blockUser(request.inviter, true); owner.current(); owner.own.blocked.add(request.inviter);
    try {
      // Blocking may remove the invitation from the next sync. Never leave a
      // room that another action has joined while the block was in flight.
      const room = owner.room();
      if (room.getMyMembership() === 'invite') { owner.invited(); await owner.client.leave(request.roomId); owner.current(); }
      else if (room.getMyMembership() === 'join') throw new Error('The room was joined elsewhere; its membership is unchanged.');
      owner.own.dismissed.set(request.roomId, scopes.get(request)!.stamp);
      return { status: 'blocked', roomId: request.roomId, message: 'User blocked and message request declined.' };
    } catch (error) {
      owner.current(); return { status: 'partial', roomId: request.roomId, message: 'The user is blocked. The invitation could not be declined: ' + (error as Error).message };
    }
  });
}
