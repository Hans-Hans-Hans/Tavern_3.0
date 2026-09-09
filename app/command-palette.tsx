import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Hash, Keyboard, MessageCircle, Plus, Search, Settings, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getMatrixClient } from '@/lib/matrix';
import { isManagedAccount } from '@/lib/api';
import { collectPalettePeople, rankPaletteItems } from '@/lib/palette-search';
import { presenceLabels, setPresenceMode, type PresenceMode } from '@/lib/presence';
import { openKeyboardShortcuts } from '@/lib/keyboard-shortcuts';
const eventName = 'tavern:command-palette';
export function openCommandPalette(mode: 'switcher' | 'commands' = 'switcher') { window.dispatchEvent(new CustomEvent(eventName, { detail: mode })); }
export function CommandPalette({ onSelectRoom, onSelectServer, onSettings, onSearch, onCreate, onContacts, onMessage }: { onSelectRoom: (id: string) => void; onSelectServer: (id: string) => void; onSettings: (tab?: string) => void; onSearch: (query?: string) => void; onCreate?: () => void; onContacts?: () => void; onMessage?: (userId: string) => void | Promise<unknown> }) {
  const [open, setOpen] = useState(false), [mode, setMode] = useState('switcher'), [query, setQuery] = useState(''), returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const show = (mode: string) => { if (!document.querySelector('[data-slot="command-input"]')) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setMode(mode); setQuery(''); setOpen(true); };
    const event = (event: Event) => show((event as CustomEvent).detail || 'switcher');
    const key = (event: KeyboardEvent) => { if (event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return; if (event.key.toLowerCase() === 'k' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); show('switcher'); } else if (event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); event.stopPropagation(); show('commands'); } };
    window.addEventListener(eventName, event); window.addEventListener('keydown', key, true); return () => { window.removeEventListener(eventName, event); window.removeEventListener('keydown', key, true); };
  }, []);
  const client = getMatrixClient();
  // Inspect only already-loaded members; opening the palette never requests a room directory.
  const inventory = useMemo(() => { const rooms = open ? client?.getRooms().filter(room => room.getMyMembership() === 'join') || [] : []; return { rooms, people: onMessage ? collectPalettePeople(rooms, client?.getUserId?.() || '') : [] }; }, [open, client, !!onMessage]);
  const search = query.trim().replace(/^[#@/]/, ''), commandsOnly = mode === 'commands' || query.trim().startsWith('/'), peopleOnly = query.trim().startsWith('@');
  const matches = rankPaletteItems(inventory.rooms, search, room => room.name + ' ' + room.roomId), people = search && onMessage && !query.startsWith('#') ? rankPaletteItems(inventory.people, search, person => person.keywords, 20) : [];
  const run = (fn: () => unknown) => { setOpen(false); void Promise.resolve().then(fn).catch(error => toast.error(error instanceof Error ? error.message : 'Unable to complete this command.')); };
  const commands = [
    { id: 'search', name: 'Search Tavern', keywords: 'find history messages files people channels servers', icon: <Search size={17}/>, run: () => onSearch() },
    { id: 'profile', name: 'Edit your profile', keywords: 'preferences profile', icon: <MessageCircle size={17}/>, run: () => onSettings('profile') },
    { id: 'security', name: 'Security and devices', keywords: 'account password mfa', icon: <Settings size={17}/>, run: () => onSettings(isManagedAccount() ? 'account' : 'privacy') },
    { id: 'appearance', name: 'Appearance and theme', keywords: 'preferences settings appearance', icon: <Settings size={17}/>, run: () => onSettings('appearance') },
    { id: 'shortcuts', name: 'Keyboard shortcuts', keywords: 'help keys reference', icon: <Keyboard size={17}/>, run: openKeyboardShortcuts },
    ...(onCreate ? [{ id: 'create', name: 'Create a channel', keywords: 'create channel', icon: <Plus size={17}/>, run: onCreate }] : []),
    ...(onContacts ? [{ id: 'contacts', name: 'Open contacts', keywords: 'friends people', icon: <Users size={17}/>, run: onContacts }] : []),
    ...Object.entries(presenceLabels).map(([id, name]) => ({ id: 'status-' + id, name: 'Set status: ' + name, keywords: 'status ' + id, icon: <Circle size={17}/>, run: async () => { await setPresenceMode(id as PresenceMode); toast.success('Status set to ' + name.toLocaleLowerCase()); } })),
  ];
  const commandsMatched = rankPaletteItems(commands, search, command => command.name + ' ' + command.keywords);
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent className='tavern-command-dialog' onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); }}><DialogHeader className='sr-only'><DialogTitle>{mode === 'switcher' ? 'Switch conversation' : 'Tavern commands'}</DialogTitle><DialogDescription>Type to search. Use arrow keys to choose and Enter to open. Prefix a person with @ or a command with /. Escape closes this menu.</DialogDescription></DialogHeader><Command shouldFilter={false}><CommandInput value={query} onValueChange={setQuery} placeholder={mode === 'switcher' ? 'Find a channel, server, conversation, or person…' : 'Find a command…'} aria-label='Search Tavern commands and conversations'/><CommandList><CommandEmpty>No matching conversations, people, or commands.</CommandEmpty>{!commandsOnly && <>
    {!peopleOnly && <><CommandGroup heading='Conversations'>{matches.filter(room => !room.isSpaceRoom()).map(room => <CommandItem key={room.roomId} value={room.roomId} onSelect={() => run(() => onSelectRoom(room.roomId))}><Hash size={17}/><span>{room.name}</span></CommandItem>)}</CommandGroup><CommandGroup heading='Servers'>{matches.filter(room => room.isSpaceRoom()).map(room => <CommandItem key={room.roomId} value={room.roomId} onSelect={() => run(() => onSelectServer(room.roomId))}><Users size={17}/><span>{room.name}</span></CommandItem>)}</CommandGroup></>}
    {people.length > 0 && <CommandGroup heading='People in loaded shared rooms'>{people.map(person => <CommandItem key={person.userId} value={'person:' + person.userId} onSelect={() => run(() => onMessage!(person.userId))}><MessageCircle size={17}/><span>{person.name}<small style={{ display: 'block', fontSize: 11 }}>{person.userId}</small></span></CommandItem>)}</CommandGroup>}<CommandSeparator/>
    </>}{!commandsOnly && !!query.trim() && <CommandGroup heading='Search all types'><CommandItem value='search-everything' onSelect={()=>run(()=>onSearch(query.trim()))}><Search size={17}/><span>Search Tavern for “{query.trim()}”</span></CommandItem></CommandGroup>}{!peopleOnly && <CommandGroup heading='Commands'>{commandsMatched.map(item => <CommandItem key={item.id} value={item.id} onSelect={() => run(item.run)}>{item.icon}<span>{item.name}</span></CommandItem>)}</CommandGroup>}</CommandList></Command><div className='community-command-hint'><span>↑ ↓ Navigate · Enter Open · Esc Close</span><span>{mode === 'switcher' ? 'Ctrl / ⌘ K' : 'Ctrl / ⌘ Shift P'}</span></div></DialogContent></Dialog>;
}
