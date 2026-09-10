import { lazy, Suspense, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Archive, BellOff, BookOpen, ChevronDown, ChevronRight, Hash, Image, LockKeyhole, Megaphone, MessageSquare, MoreHorizontal, Move, Plus, Settings2, UserPlus, Video, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient, markMatrixRoomsRead, onMatrixUpdate } from '@/lib/matrix';
import { canEditCommunity, collapsedCategories, readChannelAppearance, readServerLayout, saveServerLayout, setCollapsedCategory, type ServerLayout } from '@/lib/community';
import { canManageCategoryPermissions, effectiveRolePermissions, mayEditCategoryLayout, readRolePolicy } from '@/lib/roles';
import { readChannelPolicy, type ChannelKind } from '@/lib/channel-policy';
import { canEditConversationDetails } from '@/lib/channel-administration';
import { canInviteToRoom } from '@/lib/interactions';
import { setRoomNotifications } from '@/lib/notifications';
import { editNavigationCategory, layoutKey, moveNavigationItem, removeNavigationCategory, rowDropEdge, type NavigationDrag, type NavigationDrop } from '@/lib/channel-navigation';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ActionMenu, type ContextAction } from './action-menu';
import { ReadStateBadges } from './read-state';
import './channel-navigation.css';

const CategoryPermissions = lazy(() => import('./category-permissions').then(module => ({ default: module.CategoryPermissions })));
export type NavigationChannel = { id: string; name: string; unread: number; mentions?: number; manualUnread?: boolean };
export type ChannelNavigationProps = {
  serverId?: string; channels: NavigationChannel[]; active: string; muted: string[]; focus: boolean; onSelect: (id: string) => void;
  renderChannel?: (channel: NavigationChannel, button: ReactNode, extraActions: ContextAction[]) => ReactNode;
  onCreateChannel?: (options: { category: string }) => void; onEditChannel?: (id: string) => void; onInviteChannel?: (id: string) => void;
  renderParticipants?: (channelId: string) => ReactNode;
  createCategoryRequest?: number;
};
const icons: Record<ChannelKind, typeof Hash> = { text: Hash, voice: Volume2, video: Video, announcement: Megaphone, rules: BookOpen, forum: MessageSquare, media: Image, 'read-only': LockKeyhole };
const empty: ServerLayout = { version: 1, categories: [], channels: [] };
type Editor = { type: 'create' | 'edit' | 'delete' | 'move' | 'permissions'; item: NavigationDrag; baseline: ServerLayout; name: string; icon: string; destination: string; before: string };

function RowActions({ label, actions }: { label: string; actions: ContextAction[] }) {
  const visible = actions.filter(action => action.visible !== false);
  if (!visible.length) return null;
  return <DropdownMenu><DropdownMenuTrigger asChild><button type='button' className='channel-row-action' data-no-drag aria-label={label}><MoreHorizontal size={16}/></button></DropdownMenuTrigger><DropdownMenuContent>{visible.map(action => <DropdownMenuItem key={action.label} variant={action.danger ? 'destructive' : 'default'} onSelect={() => { try { Promise.resolve(action.run()).catch(error => toast.error(error.message)); } catch (error) { toast.error((error as Error).message); } }}>{action.label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>;
}

export function ChannelNavigation(props: ChannelNavigationProps) {
  const { serverId, channels, active, muted, focus, onSelect, renderChannel, onCreateChannel, onEditChannel, onInviteChannel, renderParticipants } = props;
  const client = getMatrixClient(), account = accountArtworkOwner(), actor = client?.getUserId(), device = client?.getDeviceId(), base = client?.getHomeserverUrl();
  const owner = useMemo(() => {
    const room = serverId ? client?.getRoom(serverId) : null;
    return { current: () => client === getMatrixClient() && account === accountArtworkOwner() && client?.getUserId() === actor && client?.getDeviceId() === device && client?.getHomeserverUrl() === base
      && (!serverId || !!room && client?.getRoom(serverId) === room && room.isSpaceRoom() && room.getMyMembership() === 'join') };
  }, [serverId, client, account, actor, device, base]);
  const layout = serverId && owner.current() ? readServerLayout(serverId) : empty;
  const signature = layoutKey(layout), nativeCollapsed = serverId ? collapsedCategories(serverId) : [];
  const [version, refresh] = useState(0), [optimistic, setOptimistic] = useState<{ owner: typeof owner; baseline: string; next: ServerLayout } | null>(null);
  const [collapse, setCollapse] = useState<{ owner: typeof owner; ids: string[] } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editor, setEditor] = useState<{ owner: typeof owner; value: Editor } | null>(null);
  const [drag, setDrag] = useState<NavigationDrag | null>(null), [drop, setDrop] = useState<NavigationDrop | null>(null), [hoverExpanded, setHoverExpanded] = useState('');
  const nav = useRef<HTMLElement>(null), live = useRef({ owner, layout, signature }); live.current = { owner, layout, signature };
  const channelList = useRef(channels); channelList.current = channels;
  const operation = useRef<object | null>(null), dragRef = useRef<{ owner: typeof owner; item: NavigationDrag; baseline: string } | null>(null), suppressClick = useRef(0);
  const categoryRequest = useRef(0);
  const hover = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null), scrolling = useRef<{ element: HTMLElement; delta: number } | null>(null), frame = useRef<number | null>(null);
  const shown = optimistic?.owner === owner && owner.current() && (signature === optimistic.baseline || signature === layoutKey(optimistic.next)) ? optimistic.next : layout;
  const collapsed = collapse?.owner === owner ? collapse.ids : nativeCollapsed;
  const policy = serverId ? readRolePolicy(serverId) : null;
  const canMove = !!serverId && owner.current() && canEditCommunity(serverId, 'layout') && (!policy || effectiveRolePermissions(policy, actor || '').has('manage_channels'));
  const modal = editor?.owner === owner && owner.current() ? editor.value : null;
  const displayChannels = new Map(channels.filter(channel => owner.current() && client?.getRoom(channel.id)?.getMyMembership() === 'join').map(channel => [channel.id, channel]));
  const groups = serverId ? [{ id: '', name: 'Uncategorized', icon: '' }, ...shown.categories] : [{ id: '', name: 'Channels', icon: '' }];

  function endDrag() {
    if (dragRef.current) suppressClick.current = performance.now() + 350;
    dragRef.current = null; setDrag(null); setDrop(null); setHoverExpanded(''); scrolling.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null;
    if (hover.current) clearTimeout(hover.current.timer); hover.current = null;
  }
  useEffect(() => {
    setOptimistic(null); setCollapse(null); setEditor(null); setError(''); setBusy(false); operation.current = null; endDrag();
    let last = '';
    return onMatrixUpdate(() => {
      const current = owner.current(), next = current && serverId ? readServerLayout(serverId) : empty;
      const nextKey = layoutKey(next), collapsedKey = current && serverId ? JSON.stringify(collapsedCategories(serverId)) : '';
      const permission = current && serverId ? [canEditCommunity(serverId, 'layout'), readRolePolicy(serverId)] : false;
      const metadata = channelList.current.map(channel => [channel.id, client?.getRoom(channel.id)?.getMyMembership(), readChannelAppearance(channel.id).icon, readChannelPolicy(channel.id)]);
      const change = JSON.stringify([current, nextKey, collapsedKey, permission, metadata]);
      if (last === change) return; last = change;
      setCollapse(null); refresh(value => value + 1);
      if (!current) { operation.current = null; setOptimistic(null); setEditor(null); setBusy(false); endDrag(); return; }
      setOptimistic(previous => previous?.owner === owner && nextKey !== previous.baseline ? null : previous);
      if (dragRef.current && dragRef.current.baseline !== nextKey) endDrag();
    });
  }, [owner, serverId]);
  useEffect(() => () => {
    operation.current = null; dragRef.current = null;
    if (hover.current) clearTimeout(hover.current.timer);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, [owner]);
  void version;
  useEffect(() => {
    const request = props.createCategoryRequest || 0;
    if (request === categoryRequest.current) return;
    categoryRequest.current = request;
    if (request > 0 && owner.current()) openEditor('create');
  }, [props.createCategoryRequest, owner]);

  function assertEditing(previous: ServerLayout) {
    if (!owner.current() || !serverId || !canEditCommunity(serverId, 'layout')) throw new Error('Your account or server permissions changed. Reopen these controls.');
    const freshPolicy = readRolePolicy(serverId);
    if (freshPolicy && !effectiveRolePermissions(freshPolicy, actor || '').has('manage_channels')) throw new Error('You cannot organize this server.');
    if (layoutKey(live.current.layout) !== layoutKey(previous) && layoutKey(shown) !== layoutKey(previous)) throw new Error('The layout changed elsewhere. Reopen these controls.');
  }
  async function save(next: ServerLayout, previous = shown) {
    if (operation.current) throw new Error('Wait for the current layout change to finish.');
    assertEditing(previous);
    const freshPolicy = readRolePolicy(serverId!);
    if (freshPolicy && !mayEditCategoryLayout(freshPolicy, actor || '', previous, next)) throw new Error('Only the server owner can move channels across category permission boundaries.');
    if (layoutKey(next) === layoutKey(previous)) { setEditor(null); return; }
    const token = {}; operation.current = token; setBusy(true); setError(''); setOptimistic({ owner, baseline: layoutKey(previous), next });
    try {
      await saveServerLayout(serverId!, next, previous);
      if (!owner.current() || operation.current !== token) return;
      const fresh = readServerLayout(serverId!), freshKey = layoutKey(fresh);
      if (freshKey !== layoutKey(previous) && freshKey !== layoutKey(next)) throw new Error('The layout changed elsewhere. The latest server order is shown.');
      if (freshKey === layoutKey(next)) setOptimistic(null);
      setEditor(null);
    } catch (failure) {
      if (owner.current() && operation.current === token) { setOptimistic(null); setError((failure as Error).message); toast.error((failure as Error).message); }
      throw failure;
    } finally { if (owner.current() && operation.current === token) { operation.current = null; setBusy(false); } }
  }
  const report = (work: Promise<unknown>) => { void work.catch(failure => { if (owner.current()) setError((failure as Error).message); }); };
  function openEditor(type: Editor['type'], item: NavigationDrag = { kind: 'category', id: crypto.randomUUID() }) {
    if (!owner.current() || operation.current) return;
    if (type !== 'permissions' && !canMove) return;
    if (type === 'permissions' && (!serverId || !canManageCategoryPermissions(serverId))) return;
    const category = shown.categories.find(value => value.id === item.id), channel = shown.channels.find(value => value.id === item.id);
    setError(''); setEditor({ owner, value: { type, item, baseline: shown, name: category?.name || '', icon: category?.icon || '', destination: channel?.category || '', before: '' } });
  }
  async function toggleCategory(id: string) {
    if (!serverId || !owner.current()) return;
    const next = !collapsed.includes(id), ids = next ? [...collapsed, id] : collapsed.filter(value => value !== id);
    setCollapse({ owner, ids });
    try { await setCollapsedCategory(serverId, id, next); if (!owner.current()) return; }
    catch (failure) { if (owner.current()) { setCollapse(null); toast.error((failure as Error).message); } }
  }
  async function categoryNotifications(id: string, mode: 'mute' | 'all') {
    if (!serverId || !client || !owner.current()) return;
    const ids = readServerLayout(serverId).channels.filter(channel => channel.category === id && displayChannels.has(channel.id)).map(channel => channel.id);
    for (const roomId of ids) {
      if (!owner.current()) return;
      if (client.getRoom(roomId)?.getMyMembership() !== 'join' || !readServerLayout(serverId).channels.some(channel => channel.id === roomId && channel.category === id)) continue;
      await setRoomNotifications(client, roomId, mode, () => owner.current() && client.getRoom(roomId)?.getMyMembership() === 'join');
    }
    if (owner.current()) toast.success('Category notifications updated');
  }
  function begin(event: DragEvent, item: NavigationDrag) {
    if (!canMove || busy || (event.target as HTMLElement).closest('[data-no-drag]')) { event.preventDefault(); return; }
    dragRef.current = { owner, item, baseline: signature }; setDrag(item); suppressClick.current = performance.now() + 350;
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-tavern-navigation', JSON.stringify(item));
  }
  function scrollNear(y: number) {
    let element = nav.current?.parentElement || null;
    while (element && !(element.scrollHeight > element.clientHeight && /auto|scroll/.test(getComputedStyle(element).overflowY))) element = element.parentElement;
    if (!element) { scrolling.current = null; return; }
    const bounds = element.getBoundingClientRect(), top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
    const delta = y < top + 42 ? -10 : y > bottom - 42 ? 10 : 0;
    scrolling.current = delta ? { element, delta } : null;
    if (frame.current === null && delta) {
      const tick = () => { if (!dragRef.current || !scrolling.current) { frame.current = null; return; } scrolling.current.element.scrollTop += scrolling.current.delta; frame.current = requestAnimationFrame(tick); };
      frame.current = requestAnimationFrame(tick);
    }
  }
  function over(event: DragEvent, target: NavigationDrop) {
    const source = dragRef.current;
    if (!source || source.owner !== owner || !owner.current() || !canMove || busy || source.baseline !== signature || source.item.kind === 'category' && (target.kind !== 'category' || target.edge === 'inside')) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDrop(target); scrollNear(event.clientY);
    const expand = source.item.kind === 'channel' && target.kind === 'category' && collapsed.includes(target.id) ? target.id : '';
    if (hover.current?.id !== expand) {
      if (hover.current) clearTimeout(hover.current.timer); hover.current = null;
      if (expand) hover.current = { id: expand, timer: setTimeout(() => { if (dragRef.current === source && owner.current()) setHoverExpanded(expand); }, 550) };
    }
  }
  function dropItem(event: DragEvent, target: NavigationDrop) {
    const source = dragRef.current;
    event.preventDefault(); event.stopPropagation();
    if (!source || source.owner !== owner || !owner.current() || !canMove || busy || source.baseline !== signature) { endDrag(); return; }
    try { const next = moveNavigationItem(shown, source.item, target); endDrag(); report(save(next)); } catch (failure) { endDrag(); toast.error((failure as Error).message); }
  }
  const targetAt = (event: DragEvent, kind: 'channel' | 'category', id: string): NavigationDrop => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (kind === 'category' && dragRef.current?.item.kind === 'channel') return { kind, id, edge: 'inside' };
    return { kind, id, edge: rowDropEdge(event.clientY, bounds.top, bounds.height) };
  };
  const indicator = (kind: string, id: string) => drop?.kind === kind && drop.id === id ? drop.edge : undefined;
  const editModal = (patch: Partial<Editor>) => setEditor(previous => previous?.owner === owner ? { owner, value: { ...previous.value, ...patch } } : previous);

  return <><nav ref={nav} aria-label='Channels' className='community-channel-navigation channel-navigation' aria-busy={busy}>
    {canMove && <div className='channel-navigation-tools'><span>CHANNELS</span><button type='button' className='channel-row-action' disabled={busy || shown.categories.length >= 100} aria-label='Create category' onClick={() => openEditor('create')}><Plus size={16}/></button></div>}
    {groups.map(group => {
      const ordered = serverId ? shown.channels.filter(channel => channel.category === group.id).flatMap(channel => displayChannels.get(channel.id) || []) : [...displayChannels.values()];
      const hidden = !!group.id && collapsed.includes(group.id) && hoverExpanded !== group.id, readable = ordered.filter(channel => !muted.includes(channel.id));
      const actions: ContextAction[] = group.id ? [
        { label: hidden ? 'Expand category' : 'Collapse category', run: () => toggleCategory(group.id) },
        { label: 'Mark category read', run: () => { if (owner.current()) return markMatrixRoomsRead(ordered.map(channel => channel.id)); } },
        { label: 'Mute category notifications', run: () => categoryNotifications(group.id, 'mute') },
        { label: 'All category notifications', run: () => categoryNotifications(group.id, 'all') },
        { label: 'Create channel', visible: canMove && !!onCreateChannel, run: () => { if (owner.current() && canMove) onCreateChannel?.({ category: group.id }); } },
        { label: 'Edit category', visible: canMove, run: () => openEditor('edit', { kind: 'category', id: group.id }) },
        { label: 'Move category', visible: canMove, run: () => openEditor('move', { kind: 'category', id: group.id }) },
        { label: 'Category permissions', visible: !!serverId && canManageCategoryPermissions(serverId), run: () => openEditor('permissions', { kind: 'category', id: group.id }) },
        { label: 'Delete category', visible: canMove, danger: true, run: () => openEditor('delete', { kind: 'category', id: group.id }) },
      ] : [];
      const header = <div className='channel-category-row' draggable={!!group.id && canMove && !busy} data-category-id={group.id} data-drop={indicator(group.id ? 'category' : 'root', group.id)} data-dragging={drag?.kind === 'category' && drag.id === group.id || undefined}
        onDragStart={event => begin(event, { kind: 'category', id: group.id })} onDragEnd={endDrag}
        onDragOver={event => over(event, group.id ? targetAt(event, 'category', group.id) : { kind: 'root', id: '', edge: 'inside' })}
        onDrop={event => dropItem(event, group.id ? targetAt(event, 'category', group.id) : { kind: 'root', id: '', edge: 'inside' })}>
        {group.id ? <button type='button' className='community-category-heading' aria-expanded={!hidden} onClick={event => { if (performance.now() < suppressClick.current) { event.preventDefault(); return; } report(toggleCategory(group.id)); }}>{hidden ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<span>{group.icon} {group.name}</span>{hidden && <ReadStateBadges unread={readable.reduce((sum, channel) => sum + channel.unread, 0)} mentions={readable.reduce((sum, channel) => sum + (channel.mentions || 0), 0)} manual={readable.some(channel => channel.manualUnread)} focus={focus}/>}</button> : <span className='channel-root-heading'>{group.name}</span>}
        {group.id && <>{canMove && <><button type='button' className='channel-row-action' data-no-drag aria-label={'Move category ' + group.name} onClick={() => openEditor('move', { kind: 'category', id: group.id })}><Move size={14}/></button>{onCreateChannel && <button type='button' className='channel-row-action' data-no-drag aria-label={'Create channel in ' + group.name} onClick={() => { if (owner.current() && canEditCommunity(serverId!, 'layout')) onCreateChannel({ category: group.id }); }}><Plus size={15}/></button>}</>}<RowActions label={'Category actions for ' + group.name} actions={actions}/></>}
      </div>;
      return <div className='channel-category' key={group.id}>{(group.id || canMove) && (group.id ? <ActionMenu actions={actions}>{header}</ActionMenu> : header)}
        {!hidden && ordered.map(channel => {
          const appearance = readChannelAppearance(channel.id), state = readChannelPolicy(channel.id), Icon = icons[state.kind], extra: ContextAction[] = [{ label: 'Move channel', visible: canMove, run: () => openEditor('move', { kind: 'channel', id: channel.id }) }];
          const edit = !!onEditChannel && canEditConversationDetails(channel.id), invite = !!onInviteChannel && canInviteToRoom(channel.id);
          const button = <button type='button' className={'channel-link ' + (active === channel.id ? 'active ' : '') + (muted.includes(channel.id) ? 'muted-channel' : '')} aria-label={channel.name} aria-current={active === channel.id ? 'page' : undefined} onClick={event => { if (!owner.current() || performance.now() < suppressClick.current || dragRef.current) { event.preventDefault(); return; } onSelect(channel.id); }}>
            {appearance.icon ? <span className='community-channel-icon' aria-hidden>{appearance.icon}</span> : <Icon size={18} aria-hidden/>}<span>{channel.name}</span><ReadStateBadges unread={channel.unread} mentions={channel.mentions} manual={channel.manualUnread} muted={muted.includes(channel.id)} focus={focus}/>{muted.includes(channel.id) && <BellOff size={13} aria-label='Muted'/>}{state.archived && <Archive size={13} aria-label='Archived'/>}</button>;
          return <div className='channel-navigation-entry' key={channel.id} data-channel-id={channel.id} data-channel-kind={state.kind}>
            <div className='channel-navigation-row' draggable={canMove && !busy} data-drop={indicator('channel', channel.id)} data-dragging={drag?.kind === 'channel' && drag.id === channel.id || undefined}
              onDragStart={event => begin(event, { kind: 'channel', id: channel.id })} onDragEnd={endDrag} onDragOver={event => over(event, targetAt(event, 'channel', channel.id))} onDrop={event => dropItem(event, targetAt(event, 'channel', channel.id))}>
              <div className='channel-navigation-select'>{renderChannel ? renderChannel(channel, button, extra) : <ActionMenu actions={extra}>{button}</ActionMenu>}</div>
              <div className='channel-row-actions'>{invite && <button type='button' className='channel-row-action' data-no-drag aria-label={'Invite to ' + channel.name} onClick={() => { if (owner.current() && canInviteToRoom(channel.id)) onInviteChannel?.(channel.id); }}><UserPlus size={14}/></button>}{edit && <button type='button' className='channel-row-action' data-no-drag aria-label={'Edit ' + channel.name} onClick={() => { if (owner.current() && canEditConversationDetails(channel.id)) onEditChannel?.(channel.id); }}><Settings2 size={14}/></button>}{canMove && <RowActions label={'Channel actions for ' + channel.name} actions={extra}/>}</div>
            </div>{state.kind === 'voice' && renderParticipants?.(channel.id)}
          </div>;
        })}
        {!hidden && !ordered.length && (group.id || canMove) && <div className='channel-empty-drop' data-drop={indicator(group.id ? 'category' : 'root', group.id)} onDragOver={event => over(event, { kind: group.id ? 'category' : 'root', id: group.id, edge: 'inside' } as NavigationDrop)} onDrop={event => dropItem(event, { kind: group.id ? 'category' : 'root', id: group.id, edge: 'inside' } as NavigationDrop)}>{canMove ? 'Drop a channel here' : 'No channels available'}</div>}
      </div>;
    })}{error && !modal && <p className='channel-navigation-error' role='status'>{error}</p>}
  </nav>
  <Dialog open={!!modal} onOpenChange={open => { if (!open && !busy) { setEditor(null); setError(''); } }}><DialogContent className='tavern-dialog channel-navigation-dialog'><DialogHeader><DialogTitle>{modal?.type === 'create' ? 'Create category' : modal?.type === 'edit' ? 'Edit category' : modal?.type === 'delete' ? 'Delete category' : modal?.type === 'permissions' ? 'Category permissions' : modal?.item.kind === 'category' ? 'Move category' : 'Move channel'}</DialogTitle><DialogDescription>{modal?.type === 'delete' ? 'Channels and their messages are kept. They move to Uncategorized and stop inheriting this category’s permissions.' : modal?.type === 'move' ? 'Choose an exact position. Changes are saved to this server and sync to its members.' : 'Organize this server using its saved categories and existing channel permissions.'}</DialogDescription></DialogHeader>
    {modal?.type === 'permissions' ? <Suspense fallback={<p role='status'>Loading category permissions…</p>}><CategoryPermissions serverId={serverId!} initialCategoryId={modal.item.id}/></Suspense> : modal && <form className='dialog-form' onSubmit={event => {
      event.preventDefault(); if (!owner.current() || !canMove) return;
      try {
        if (layoutKey(shown) !== layoutKey(modal.baseline)) throw new Error('The layout changed elsewhere. Close and reopen these controls.');
        let next: ServerLayout;
        if (modal.type === 'create' || modal.type === 'edit') next = editNavigationCategory(shown, modal.item.id, modal.name, modal.icon, modal.type === 'create');
        else if (modal.type === 'delete') next = removeNavigationCategory(shown, modal.item.id);
        else if (modal.item.kind === 'category') {
          const others = shown.categories.filter(category => category.id !== modal.item.id), target = modal.before || others.at(-1)?.id;
          if (!target) { setEditor(null); return; }
          next = moveNavigationItem(shown, modal.item, { kind: 'category', id: target, edge: modal.before ? 'before' : 'after' });
        } else next = moveNavigationItem(shown, modal.item, modal.before ? { kind: 'channel', id: modal.before, edge: 'before' } : { kind: modal.destination ? 'category' : 'root', id: modal.destination, edge: 'inside' } as NavigationDrop);
        report(save(next, modal.baseline));
      } catch (failure) { setError((failure as Error).message); }
    }}><fieldset disabled={busy || !canMove}>
      {(modal.type === 'create' || modal.type === 'edit') && <><label>Category name<input required maxLength={60} value={modal.name} onChange={event => editModal({ name: event.target.value })} autoFocus/></label><label>Category icon <span className='login-help'>(optional)</span><input maxLength={16} value={modal.icon} onChange={event => editModal({ icon: event.target.value })} placeholder='📁'/></label></>}
      {modal.type === 'delete' && <p>Delete <strong>{shown.categories.find(category => category.id === modal.item.id)?.name}</strong>? This does not delete any channel.</p>}
      {modal.type === 'move' && <>{modal.item.kind === 'channel' && <label>Category<select value={modal.destination} onChange={event => editModal({ destination: event.target.value, before: '' })}><option value=''>Uncategorized</option>{shown.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}<label>Position<select value={modal.before} onChange={event => editModal({ before: event.target.value })}><option value=''>At the end</option>{modal.item.kind === 'category' ? shown.categories.filter(category => category.id !== modal.item.id).map(category => <option key={category.id} value={category.id}>Before {category.name}</option>) : shown.channels.filter(channel => channel.id !== modal.item.id && channel.category === modal.destination && displayChannels.has(channel.id)).map(channel => <option key={channel.id} value={channel.id}>Before {displayChannels.get(channel.id)!.name}</option>)}</select></label></>}
      <div className='product-actions'><button type='submit' className={modal.type === 'delete' ? 'danger-button' : 'primary-button'}>{busy ? 'Saving…' : modal.type === 'delete' ? 'Delete category and keep channels' : modal.type === 'move' ? 'Save position' : 'Save category'}</button><button type='button' className='secondary-button' onClick={() => setEditor(null)}>Cancel</button></div>
    </fieldset>{error && <p className='connect-error' role='alert'>{error}</p>}</form>}
  </DialogContent></Dialog></>;
}
