import type { MatrixClient, Room } from 'matrix-js-sdk';
import { addDirectMessage, readDirectMessageMap } from './dm-account-data';

export function canRestoreDirectListing(room: Room | null | undefined): boolean {
  if (!room || room.getMyMembership() !== 'join' || room.isSpaceRoom() || !room.hasEncryptionStateEvent()) return false;
  const state = room.currentState;
  return state.getStateEvents('m.room.join_rules', '')?.getContent().join_rule === 'invite'
    && !state.getStateEvents('m.room.create', '')?.getContent().type
    && !state.getStateEvents('m.space.parent').some(event => event.getContent().via?.length);
}

/** Explicit personal classification only. Never create, join or change a room. */
export async function restoreDirectListing(client: MatrixClient, roomId: string, current: () => void,
  mutate: (update: (old: unknown) => unknown, validate: () => void) => Promise<unknown>) {
  const room = client.getRoom(roomId), actor = client.getUserId();
  const check = () => { current(); if (!actor || client.getRoom(roomId) !== room || !canRestoreDirectListing(room)) throw new Error('Choose a joined, encrypted private conversation outside a server.'); };
  check(); const events = await client.roomState(roomId); check();
  if (!Array.isArray(events) || events.length > 50000) throw new Error('Conversation membership could not be checked.');
  const seen = new Set<string>();
  for (const event of events) {
    const key = JSON.stringify([event?.type, event?.state_key]);
    if (!event || typeof event.type !== 'string' || typeof event.state_key !== 'string' || !event.content || typeof event.content !== 'object' || Array.isArray(event.content) || seen.has(key) || event.room_id !== undefined && event.room_id !== roomId) throw new Error('The conversation state is invalid.');
    seen.add(key);
  }
  const find = (type: string, key = '') => events.find(event => event.type === type && event.state_key === key)?.content;
  if (find('m.room.create')?.type || find('m.room.encryption')?.algorithm !== 'm.megolm.v1.aes-sha2' || find('m.room.join_rules')?.join_rule !== 'invite'
    || events.some(event => event.type === 'm.space.parent' && event.content.via?.length)
    || find('m.room.member', actor!)?.membership !== 'join') throw new Error('This conversation is no longer an eligible private message.');
  const peers = events.filter(event => event.type === 'm.room.member' && (event.content.membership === 'join' || event.content.membership === 'invite') && event.state_key !== actor).map(event => event.state_key!);
  if (peers.length > 50) throw new Error('This conversation has too many members for the Messages list.');
  const participants = peers.length ? peers : [actor!];
  await mutate(old => addDirectMessage(old, participants, roomId), check); check();
  const saved = await readDirectMessageMap(client, check);
  if (!participants.every(peer => saved[peer]?.includes(roomId))) throw new Error('The Messages list changed elsewhere before the save could be confirmed. Retry this same conversation.');
}
