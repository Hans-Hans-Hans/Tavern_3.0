import type { ServerLayout } from './community';

export type NavigationDrag = { kind: 'channel' | 'category'; id: string };
export type NavigationDrop = { kind: 'channel'; id: string; edge: 'before' | 'after' } | { kind: 'category'; id: string; edge: 'before' | 'after' | 'inside' } | { kind: 'root'; id: ''; edge: 'inside' };
export const layoutKey = (layout: ServerLayout) => JSON.stringify(layout);

/** The existing arrays are the persisted order. Never derive positions from names. */
export function moveNavigationItem(layout: ServerLayout, item: NavigationDrag, target: NavigationDrop): ServerLayout {
  if (item.kind === 'category') {
    if (target.kind !== 'category' || target.edge === 'inside') throw new Error('Move categories before or after another category.');
    const value = layout.categories.find(category => category.id === item.id);
    if (!value || !layout.categories.some(category => category.id === target.id)) throw new Error('This category changed. Reopen the move controls.');
    if (item.id === target.id) return layout;
    const categories = layout.categories.filter(category => category.id !== item.id), at = categories.findIndex(category => category.id === target.id);
    categories.splice(at + Number(target.edge === 'after'), 0, value);
    return { ...layout, categories };
  }
  if (!layout.channels.some(channel => channel.id === item.id)) throw new Error('This channel is no longer in the server.');
  const channels = layout.channels.filter(channel => channel.id !== item.id);
  let category = '', at = channels.length;
  if (target.kind === 'channel') {
    const anchor = layout.channels.find(channel => channel.id === target.id);
    if (!anchor) throw new Error('The destination channel changed. Reopen the move controls.');
    if (item.id === target.id) return layout;
    category = anchor.category; at = channels.findIndex(channel => channel.id === target.id) + Number(target.edge === 'after');
  } else {
    if (target.edge !== 'inside') throw new Error('Drop the channel inside its destination category.');
    if (target.kind === 'category') {
      if (!layout.categories.some(value => value.id === target.id)) throw new Error('The destination category changed.');
      category = target.id;
    }
    let last = -1;
    for (let index = channels.length - 1; index >= 0; index--) if (channels[index].category === category) { last = index; break; }
    if (last >= 0) at = last + 1;
  }
  channels.splice(at, 0, { id: item.id, category });
  return { ...layout, channels };
}
export function removeNavigationCategory(layout: ServerLayout, id: string): ServerLayout {
  if (!layout.categories.some(category => category.id === id)) throw new Error('This category no longer exists.');
  return { ...layout, categories: layout.categories.filter(category => category.id !== id), channels: layout.channels.map(channel => channel.category === id ? { ...channel, category: '' } : channel) };
}
export function editNavigationCategory(layout: ServerLayout, id: string, name: string, icon: string, create = false): ServerLayout {
  if (!name.trim() || name.trim().length > 60 || /[\x00-\x1f\x7f]/.test(name) || icon.length > 16) throw new Error('Use a category name of 1–60 characters and an optional short icon.');
  const existing = layout.categories.some(category => category.id === id);
  if (create ? existing || layout.categories.length >= 100 : !existing) throw new Error('The category list changed or reached its limit.');
  const next = { id, name: name.trim(), icon: icon.trim() };
  return { ...layout, categories: create ? [...layout.categories, next] : layout.categories.map(category => category.id === id ? next : category) };
}
export function rowDropEdge(clientY: number, top: number, height: number): 'before' | 'after' { return clientY < top + height / 2 ? 'before' : 'after'; }
