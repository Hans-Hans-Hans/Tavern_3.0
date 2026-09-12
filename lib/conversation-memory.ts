type Room = { id: string; kind: string };
type Server = { id: string; roomIds: string[] };
type Memory = { section: string; rooms: Record<string, string>; landing: 'last' | 'home' };
const id = (v: unknown): v is string => typeof v === 'string' && /^![^\s/\\?#]{1,254}$/.test(v);
const section = (v: unknown): v is string => v === 'all' || v === 'dms' || id(v);
const empty = (): Memory => ({ section: 'all', rooms: {}, landing: 'last' });
export function navigationScope(client: { getHomeserverUrl(): string; getUserId(): string | null } | null) {
  return client?.getUserId() ? JSON.stringify([client.getHomeserverUrl(), client.getUserId()]) : '';
}
export function readConversationMemory(scope: string, storage?: Pick<Storage, 'getItem'>): Memory {
  try {
    if (!scope) return empty();
    const raw = (storage || globalThis.localStorage).getItem('tavern.navigation.v1:' + scope);
    if (!raw || raw.length > 80000) return empty();
    const value = JSON.parse(raw);
    return { section: section(value?.section) ? value.section : 'all', landing: value?.landing === 'home' ? 'home' : 'last',
      rooms: Object.fromEntries(Object.entries(value?.rooms || {}).slice(-100).filter(([key, value]) => section(key) && id(value))) as Record<string, string> };
  } catch { return empty(); }
}
export function saveConversationMemory(scope: string, change: { section?: string; roomId?: string; landing?: 'last' | 'home' }, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  if (!scope) return;
  const previous = readConversationMemory(scope, storage);
  const chosen = section(change.section) ? change.section : previous.section;
  const rooms = { ...previous.rooms };
  if (id(change.roomId)) { delete rooms[chosen]; rooms[chosen] = change.roomId; }
  try { (storage || globalThis.localStorage).setItem('tavern.navigation.v1:' + scope, JSON.stringify({ section: chosen, rooms: Object.fromEntries(Object.entries(rooms).slice(-100)), landing: change.landing || previous.landing })); } catch { /* Navigation still works without browser storage. */ }
}
export function rememberedConversation(memory: Memory, sectionId: string, rooms: Room[], servers: Server[]) {
  const server = servers.find(value => value.id === sectionId);
  const available = rooms.filter(room => sectionId === 'dms' ? room.kind === 'dm' : room.kind !== 'dm' && (!server || server.roomIds.includes(room.id)));
  return available.find(room => room.id === memory.rooms[sectionId]) || available[0];
}
