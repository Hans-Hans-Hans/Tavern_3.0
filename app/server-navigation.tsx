import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Folder, FolderOpen, FolderPlus, MoreHorizontal, Star } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { navigationPreferences, setNavigationFlag } from '@/lib/interactions';
import { moveServerRelative, orderedServerIds, positionFolder, positionServer, readServerNavigation, refreshServerNavigation, saveServerFolder, serverFolderId, serverNavigationOwner, subscribeServerNavigation, updateServerNavigation, type ServerFolder, type ServerNavigationState } from '@/lib/server-navigation';
import { serverReadCounts } from '@/lib/read-state';
import { ReadStateBadges } from './read-state';
import { readServerBranding } from '@/lib/community';
import { CommunityImage } from './community-settings';
import { ActionMenu, type ContextAction } from './action-menu';
import './server-navigation.css';
type Server = { id: string; name: string };
export type ServerNavigationReadState = { roomIds: readonly string[]; muted: readonly string[]; focus: boolean };
type DragItem = { kind: 'server' | 'folder'; id: string };
type Drop = { kind: 'server' | 'folder' | 'inside' | 'root'; id: string; side?: 'before' | 'after' };
type Edit = { draft: ServerFolder; original: ServerFolder | null };
export function ServerNavigation({ servers, active, onSelectServer, renderServer, readState }: { readState?: ServerNavigationReadState; servers: Server[]; active: string; onSelectServer: (id: string) => void; renderServer?: (server: Server, button: ReactNode, organizationActions: ContextAction[]) => ReactNode }) {
  const [state, setState] = useState(readServerNavigation), [favorites, setFavorites] = useState(() => navigationPreferences().favorites);
  const [owner, setOwner] = useState(serverNavigationOwner), [editing, setEditing] = useState<Edit | null>(null), [moving, setMoving] = useState<DragItem | null>(null), [destination, setDestination] = useState(''), [before, setBefore] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState<DragItem | null>(null), [drop, setDrop] = useState<Drop | null>(null);
  const ownerRef = useRef(owner), dragRef = useRef<DragItem | null>(null), suppressClick = useRef(0), alive = useRef(true), rail = useRef<HTMLDivElement>(null), hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  ownerRef.current = owner;
  useEffect(() => {
    alive.current = true;
    const sync = () => { if (!alive.current) return; if (!ownerRef.current.current()) { const next = serverNavigationOwner(); ownerRef.current = next; setOwner(next); setEditing(null); setMoving(null); setBusy(false); setError(''); setDragging(null); dragRef.current = null; setDrop(null); } setState(readServerNavigation()); setFavorites(navigationPreferences().favorites); };
    const off = subscribeServerNavigation(sync), matrixOff = onMatrixUpdate(() => refreshServerNavigation()); sync();
    return () => { alive.current = false; off(); matrixOff(); clearTimeout(hover.current); };
  }, []);
  const current = () => alive.current && owner.current();
  const known = servers.map(server => server.id), order = orderedServerIds(state, known), ordered = [...servers].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  async function update(mutate: (old: ServerNavigationState) => ServerNavigationState) { if (!current()) return; try { await updateServerNavigation(mutate); } catch (e) { if (current()) toast.error((e as Error).message); } }
  function openMove(item: DragItem) { if (!current()) return; setError(''); setMoving(item); setDestination(item.kind === 'server' ? serverFolderId(state, item.id) : ''); setBefore(''); }
  function openFolder(folder?: ServerFolder) { if (!current()) return; setError(''); const original = folder ? structuredClone(folder) : null; setEditing({ original, draft: original ? structuredClone(original) : { id: crypto.randomUUID(), name: '', color: '#d7b880', serverIds: [] } }); }
  function toggleFolder(id: string) { void update(p => ({ ...p, collapsed: p.collapsed.includes(id) ? p.collapsed.filter(value => value !== id) : [...p.collapsed, id] })); }
  function startDrag(e: DragEvent, item: DragItem) { if (!current()) { e.preventDefault(); return; } dragRef.current = item; setDragging(item); suppressClick.current = Date.now() + 500; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/tavern-' + item.kind, item.id); }
  function endDrag() { dragRef.current = null; setDragging(null); setDrop(null); clearTimeout(hover.current); hover.current = undefined; suppressClick.current = Date.now() + 200; }
  function over(e: DragEvent, next: Drop) {
    const item = dragRef.current; if (!item || !current() || item.kind === 'folder' && next.kind !== 'folder' || item.kind === 'server' && next.kind === 'folder') return;
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDrop(next);
    const box = rail.current?.getBoundingClientRect(); if (box && rail.current) { if (e.clientY < box.top + 32) rail.current.scrollTop -= 18; else if (e.clientY > box.bottom - 32) rail.current.scrollTop += 18; }
  }
  function receive(e: DragEvent, target: Drop) {
    const item = dragRef.current; if (!item || !current()) return; e.preventDefault(); e.stopPropagation(); endDrag();
    if (item.kind === 'server' && servers.some(server => server.id === item.id)) {
      if (target.kind === 'server' && servers.some(server => server.id === target.id)) void update(p => moveServerRelative(p, item.id, target.id, target.side || 'before', known));
      else if (target.kind === 'inside' || target.kind === 'root') void update(p => positionServer(p, item.id, target.kind === 'root' ? '' : target.id, '', known));
    } else if (item.kind === 'folder' && target.kind === 'folder') void update(p => {
      const rest = p.folders.filter(folder => folder.id !== item.id), at = rest.findIndex(folder => folder.id === target.id);
      if (at < 0) return p; return positionFolder(p, item.id, target.side === 'after' ? rest[at + 1]?.id || '' : target.id);
    });
  }
  const side = (e: DragEvent) => e.clientY < e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2 ? 'before' as const : 'after' as const;
  const marker = (kind: Drop['kind'], id: string) => drop?.kind === kind && drop.id === id ? ' drop-' + (drop.side || 'inside') : '';
  const visibleRooms = new Set(readState?.roomIds || []), mutedRooms = new Set(readState?.muted || []), manualRooms = new Set(navigationPreferences().unread || []);
  const button = (server: Server) => {
    const client = getMatrixClient(), counts = client && readState ? serverReadCounts(client, server.id, visibleRooms, mutedRooms, manualRooms) : null;
    const branding = readServerBranding(server.id), organization: ContextAction[] = [
      { label: 'Move server…', run: () => openMove({ kind: 'server', id: server.id }), separator: true },
      { label: favorites.includes(server.id) ? 'Remove favorite' : 'Favorite server', run: () => { if (current()) return setNavigationFlag(server.id, 'favorites', !favorites.includes(server.id)); } },
    ];
    const element = <button className={'workspace-icon ' + (active === server.id ? 'selected' : '')} title={server.name} aria-label={server.name} draggable onDragStart={e => startDrag(e, { kind: 'server', id: server.id })} onDragEnd={endDrag} onClick={() => { if (current() && Date.now() >= suppressClick.current) onSelectServer(server.id); }}>{branding.icon ? <CommunityImage mxc={branding.icon} name={server.name} size={40}/> : server.name.split(/\s+/).map(v => v[0]).join('').slice(0, 2).toUpperCase()}</button>;
    return <div key={server.id} className={'server-rail-item' + marker('server', server.id) + (dragging?.kind === 'server' && dragging.id === server.id ? ' is-dragging' : '')} data-server-id={server.id} onDragOver={e => over(e, { kind: 'server', id: server.id, side: side(e) })} onDrop={e => receive(e, { kind: 'server', id: server.id, side: side(e) })}>
      {renderServer ? renderServer(server, element, organization) : <ActionMenu actions={organization}>{element}</ActionMenu>}
      {counts && <span className='server-read-state'><ReadStateBadges {...counts} focus={readState?.focus}/></span>}
      <button type='button' className='server-organize-button' aria-label={'Move ' + server.name} title={'Move ' + server.name} onClick={() => openMove({ kind: 'server', id: server.id })}><MoreHorizontal size={14}/></button>
    </div>;
  };
  const moveName = moving?.kind === 'server' ? servers.find(server => server.id === moving.id)?.name : state.folders.find(folder => folder.id === moving?.id)?.name;
  if (!owner.current()) return null;
  return <><div ref={rail} className='community-server-navigation server-rail-navigation' aria-label='Servers and folders' onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDrop(null); clearTimeout(hover.current); } }}>
    {ordered.some(server => favorites.includes(server.id)) && <div className='community-server-group' aria-label='Favorite servers'><Star size={14} aria-hidden='true'/>{ordered.filter(server => favorites.includes(server.id)).map(button)}</div>}
    <div className={'server-rail-root' + marker('root', '')} aria-label='Servers outside folders' onDragOver={e => over(e, { kind: 'root', id: '' })} onDrop={e => receive(e, { kind: 'root', id: '' })}>{ordered.filter(server => !serverFolderId(state, server.id) && !favorites.includes(server.id)).map(button)}{dragging?.kind === 'server' && <span className='server-root-target'>Move out of folder</span>}</div>
    {state.folders.map(folder => <div key={folder.id} className={'community-server-folder' + marker('folder', folder.id) + marker('inside', folder.id) + (dragging?.kind === 'folder' && dragging.id === folder.id ? ' is-dragging' : '')} data-folder-id={folder.id} onDragOver={e => {
      const target: Drop = dragRef.current?.kind === 'folder' ? { kind: 'folder', id: folder.id, side: side(e) } : { kind: 'inside', id: folder.id }; over(e, target);
      if (dragRef.current?.kind === 'server' && state.collapsed.includes(folder.id) && !hover.current) hover.current = setTimeout(() => { hover.current = undefined; if (dragRef.current && current()) toggleFolder(folder.id); }, 600);
    }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { clearTimeout(hover.current); hover.current = undefined; } }} onDrop={e => receive(e, dragRef.current?.kind === 'folder' ? { kind: 'folder', id: folder.id, side: side(e) } : { kind: 'inside', id: folder.id })}>
      <div className='server-rail-item'><ActionMenu actions={[{ label: 'Edit folder', run: () => openFolder(folder) }, { label: 'Move folder…', run: () => openMove({ kind: 'folder', id: folder.id }) }, { label: state.collapsed.includes(folder.id) ? 'Expand folder' : 'Collapse folder', run: () => toggleFolder(folder.id) }, { label: 'Remove folder (keep servers)', run: () => update(p => ({ ...p, folders: p.folders.filter(f => f.id !== folder.id), collapsed: p.collapsed.filter(id => id !== folder.id) })), danger: true }]}>
        <button className='workspace-icon community-folder-button' title={folder.name} aria-label={folder.name} aria-expanded={!state.collapsed.includes(folder.id)} style={{ color: folder.color || undefined }} draggable onDragStart={e => startDrag(e, { kind: 'folder', id: folder.id })} onDragEnd={endDrag} onClick={() => { if (Date.now() >= suppressClick.current) toggleFolder(folder.id); }}>{state.collapsed.includes(folder.id) ? <Folder size={23}/> : <FolderOpen size={23}/>}</button>
      </ActionMenu><button className='server-organize-button' aria-label={'Edit folder ' + folder.name} title={'Edit folder ' + folder.name} onClick={() => openFolder(folder)}><MoreHorizontal size={14}/></button></div>
      {!state.collapsed.includes(folder.id) && ordered.filter(server => folder.serverIds.includes(server.id) && !favorites.includes(server.id)).map(button)}
    </div>)}
    <button className='icon-button' title='Create server folder' aria-label='Create server folder' disabled={state.folders.length >= 32} onClick={() => openFolder()}><FolderPlus size={20}/></button>
  </div>
  <Dialog open={!!moving} onOpenChange={value => { if (!value && !busy) setMoving(null); }}><DialogContent className='tavern-dialog server-organize-dialog'><DialogHeader><DialogTitle>Move {moveName || (moving?.kind === 'folder' ? 'folder' : 'server')}</DialogTitle><DialogDescription>Choose the exact position. This organization is private to your account and syncs across devices.</DialogDescription></DialogHeader>{moving && <form className='dialog-form' onSubmit={async e => { e.preventDefault(); if (!current() || !moveName) return; setBusy(true); setError(''); try { await updateServerNavigation(p => moving.kind === 'server' ? positionServer(p, moving.id, destination, before, known) : positionFolder(p, moving.id, before)); if (current()) setMoving(null); } catch (error) { if (current()) setError((error as Error).message); } finally { if (current()) setBusy(false); } }}>
    {moving.kind === 'server' && <label>Location<select value={destination} onChange={e => { setDestination(e.target.value); setBefore(''); }}><option value=''>Outside folders</option>{state.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>}
    <label>Position<select value={before} onChange={e => setBefore(e.target.value)}><option value=''>At the end</option>{(moving.kind === 'server' ? ordered.filter(server => server.id !== moving.id && serverFolderId(state, server.id) === destination) : state.folders.filter(folder => folder.id !== moving.id)).map(item => <option key={item.id} value={item.id}>Before {item.name}</option>)}</select></label>
    {moving.kind === 'server' && favorites.includes(moving.id) && <p>Favorite servers stay pinned above folders. Remove the favorite to show this server in its folder.</p>}<button className='primary-button' disabled={busy || !moveName}>{busy ? 'Saving…' : 'Move'}</button>{error && <p role='alert' className='connect-error'>{error}</p>}
  </form>}</DialogContent></Dialog>
  <Dialog open={!!editing} onOpenChange={value => { if (!value && !busy) setEditing(null); }}><DialogContent className='tavern-dialog server-organize-dialog'><DialogHeader><DialogTitle>{editing?.original ? 'Edit server folder' : 'Create server folder'}</DialogTitle><DialogDescription>Folders are private to your account. Removing a folder keeps every server.</DialogDescription></DialogHeader>{editing && <form className='dialog-form' onSubmit={async e => { e.preventDefault(); if (!current()) return; setBusy(true); setError(''); try { await updateServerNavigation(p => saveServerFolder(p, editing.draft, editing.original)); if (current()) { setEditing(null); toast.success('Folder saved'); } } catch (error) { if (current()) setError((error as Error).message); } finally { if (current()) setBusy(false); } }}>
    <label>Folder name<input required maxLength={60} value={editing.draft.name} onChange={e => setEditing(p => p && ({ ...p, draft: { ...p.draft, name: e.target.value } }))}/></label><label>Color<input type='color' value={editing.draft.color || '#d7b880'} onChange={e => setEditing(p => p && ({ ...p, draft: { ...p.draft, color: e.target.value } }))}/></label>
    <div className='member-picker'>{servers.map(server => <label className='check-label' key={server.id}><input type='checkbox' checked={editing.draft.serverIds.includes(server.id)} onChange={e => setEditing(p => p && ({ ...p, draft: { ...p.draft, serverIds: e.target.checked ? [...p.draft.serverIds, server.id] : p.draft.serverIds.filter(id => id !== server.id) } }))}/>{server.name}</label>)}</div>
    <button className='primary-button' disabled={busy}>{busy ? 'Saving…' : 'Save folder'}</button>{editing.original && <div className='inline-actions'><button type='button' className='secondary-button' disabled={busy} onClick={() => { const id = editing.draft.id; setEditing(null); openMove({ kind: 'folder', id }); }}>Move folder…</button><button type='button' className='secondary-button' disabled={busy} onClick={async () => { const id = editing.draft.id; setBusy(true); try { await updateServerNavigation(p => ({ ...p, folders: p.folders.filter(folder => folder.id !== id), collapsed: p.collapsed.filter(value => value !== id) })); if (current()) setEditing(null); } catch (error) { if (current()) setError((error as Error).message); } finally { if (current()) setBusy(false); } }}>Remove folder (keep servers)</button></div>}{error && <p role='alert' className='connect-error'>{error}</p>}
  </form>}</DialogContent></Dialog></>;
}
