export function paletteMatchScore(value: string, query: string) {
  const text = value.toLocaleLowerCase(), term = query.trim().toLocaleLowerCase();
  if (!term) return 1;
  const contiguous = text.indexOf(term); if (contiguous >= 0) return 10000 - contiguous - text.length / 1000;
  let at = 0, previous = -1, cost = 0;
  for (const character of term) { const found = text.indexOf(character, at); if (found < 0) return 0; cost += found - previous - 1; previous = found; at = found + 1; }
  return 1000 / (1 + cost + text.length / 1000);
}
export function rankPaletteItems<T>(items: T[], query: string, describe: (item: T) => string, limit = 60) { return items.map((item, index) => ({ item, index, score: paletteMatchScore(describe(item), query) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, Math.max(0, limit)).map(item => item.item); }
export type PalettePerson = { userId: string; name: string; keywords: string };
type MemberSource = { userId: string; name?: string; rawDisplayName?: string; membership?: string };
export function collectPalettePeople(rooms: { getJoinedMembers?: () => MemberSource[] }[], ownUser: string, limit = 5000) {
  const people = new Map<string, PalettePerson>(); let scanned = 0;
  for (const room of rooms) {
    for (const member of room.getJoinedMembers?.() || []) {
      if (++scanned > limit) return [...people.values()];
      if (!member.userId || member.userId === ownUser || member.membership && member.membership !== 'join') continue;
      const name = member.name || member.rawDisplayName || member.userId, existing = people.get(member.userId);
      if (existing) { if (!existing.keywords.includes(name)) existing.keywords = (existing.keywords + ' ' + name).slice(0, 1200); }
      else people.set(member.userId, { userId: member.userId, name, keywords: (member.userId + ' ' + name).slice(0, 1200) });
    }
  }
  return [...people.values()];
}
