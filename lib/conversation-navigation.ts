type Conversation = { id: string; kind: string };
type Server = { id: string; roomIds: string[] };
/** Restore real servers, never a synthetic default server. Preserve an
 * intentional DM/server selection or a standalone last room when restoring. */
export function initialServerSection(section: string, roomId: string | undefined, rooms: Conversation[], servers: Server[]): string {
  if (section === 'dms' || servers.some(server => server.id === section)) return section;
  const room = rooms.find(room => room.id === roomId);
  if (room?.kind === 'dm') return 'dms';
  if (room) return servers.find(server => server.roomIds.includes(room.id))?.id || 'all';
  return servers[0]?.id || 'all';
}
export function sectionConversations<T extends Conversation>(rooms: T[], servers: Server[], section: string): T[] {
  const server = servers.find(value => value.id === section);
  return rooms.filter(room => section === 'dms' ? room.kind === 'dm' : room.kind !== 'dm' && (server ? server.roomIds.includes(room.id) : !servers.some(parent => parent.roomIds.includes(room.id))));
}
export function sectionForConversation(rooms: Conversation[], servers: Server[], current: string, roomId: string): string {
  const room = rooms.find(value => value.id === roomId);
  if (!room) return current;
  if (room.kind === 'dm') return 'dms';
  if (servers.some(server => server.id === current && server.roomIds.includes(roomId))) return current;
  return servers.find(server => server.roomIds.includes(roomId))?.id || 'all';
}
