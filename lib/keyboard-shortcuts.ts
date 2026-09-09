export type UnreadConversation = { id: string; unread: number; muted?: boolean };
export type UnreadShortcut = 'alt' | 'alt-shift' | 'disabled';
export function nextUnreadConversation(conversations: UnreadConversation[], current: string, direction: -1 | 1): string | null {
  const seen = new Set<string>(), rooms = conversations.filter(room => { if (!room.id || seen.has(room.id)) return false; seen.add(room.id); return true; });
  if (!rooms.length) return null;
  const found = rooms.findIndex(room => room.id === current), start = found < 0 ? direction === 1 ? -1 : 0 : found;
  for (let step = 1; step <= rooms.length; step++) { const room = rooms[(start + step * direction + rooms.length) % rooms.length]; if (room.id !== current && !room.muted && room.unread > 0) return room.id; }
  return null;
}
export function normalizeUnreadShortcut(value: unknown): UnreadShortcut { return value === 'disabled' || value === 'alt-shift' ? value : 'alt'; }
export function matchTavernShortcut(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented'>, unread: UnreadShortcut) {
  if (event.defaultPrevented || event.isComposing) return null;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === '/' || event.code === 'Slash')) return 'reference';
  if (unread === 'disabled' || event.ctrlKey || event.metaKey || !event.altKey || event.shiftKey !== (unread === 'alt-shift')) return null;
  return event.key === 'ArrowUp' ? 'previous-unread' : event.key === 'ArrowDown' ? 'next-unread' : null;
}
export const openKeyboardShortcuts = () => window.dispatchEvent(new Event('tavern:keyboard-shortcuts'));
