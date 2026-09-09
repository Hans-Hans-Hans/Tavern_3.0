export type MessageAnchor = { id: string; author_id: string };
export function firstUnreadMessage(messages: MessageAnchor[], readId: string | null, userId: string, hasUnread: boolean) {
  if (!hasUnread) return null;
  const at = readId ? messages.findIndex(message => message.id === readId) : -1;
  return messages.slice(at + 1).find(message => message.author_id !== userId)?.id || null;
}
export function parseConversationLink(hash: string) {
  const params = new URLSearchParams(hash.replace(/^#/, '')), roomId = params.get('room') || params.get('server') || '';
  const eventId = params.get('event') || '';
  return { roomId: /^![^\s]{1,254}$/.test(roomId) ? roomId : '', eventId: /^\$[^\s]{1,1023}$/.test(eventId) ? eventId : '' };
}
