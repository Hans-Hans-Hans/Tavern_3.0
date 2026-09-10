import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner, requestApi } from '@/lib/api';
import { Field } from './auth-gateway';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AdminRoomHierarchy } from './admin-room-hierarchy';
import { toast } from 'sonner';

function checkedDetail(value: any, roomId: string) {
  if (value?.room?.room_id !== roomId || typeof value.blocked !== 'boolean' || !Array.isArray(value.members?.members) || value.members.members.length > 100 ||
    value.members.members.some((id: unknown) => typeof id !== 'string') || !Number.isSafeInteger(value.members.total) || value.members.total < 0 ||
    value.members.next !== null && (!Number.isSafeInteger(value.members.next) || value.members.next < 1)) throw new Error('The room details could not be read. Inspect this room again.');
  return value;
}

export function AdminRooms() {
  const [query, setQuery] = useState(''), [page, setPage] = useState(0), [data, setData] = useState<any>(null), [detail, setDetail] = useState<any>(null);
  const [listBusy, setListBusy] = useState(false), [detailBusy, setDetailBusy] = useState(false), [mutating, setMutating] = useState(false);
  const [error, setError] = useState(''), [confirmation, setConfirmation] = useState(''), [stale, setStale] = useState(false);
  const owner = useRef(accountArtworkOwner()), alive = useRef(true), listing = useRef(0), inspecting = useRef(0), selected = useRef('');
  const current = () => alive.current && owner.current === accountArtworkOwner();
  async function load() {
    if (!current()) return;
    const request = ++listing.current; setListBusy(true); setError('');
    try {
      const value = await requestApi('/admin/rooms?from=' + page + '&search=' + encodeURIComponent(query));
      if (current() && listing.current === request) setData(value);
    } catch (e: any) { if (current() && listing.current === request) setError(e.message); }
    finally { if (current() && listing.current === request) setListBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    const check = () => { if (!current()) { setStale(true); setData(null); setDetail(null); selected.current = ''; } };
    const timer = window.setInterval(check, 250); window.addEventListener('tavern:signout', check);
    return () => { alive.current = false; listing.current++; inspecting.current++; clearInterval(timer); window.removeEventListener('tavern:signout', check); };
  }, []);
  useEffect(() => { void load(); }, [page]);
  async function inspect(id: string) {
    if (!current()) return;
    const request = ++inspecting.current; selected.current = id;
    setDetailBusy(true); setDetail(null); setError(''); setConfirmation('');
    try {
      const value = checkedDetail(await requestApi('/admin/rooms/' + encodeURIComponent(id)), id);
      if (current() && inspecting.current === request && selected.current === id) setDetail(value);
    } catch (e: any) { if (current() && inspecting.current === request) setError(e.message); }
    finally { if (current() && inspecting.current === request) setDetailBusy(false); }
  }
  async function moreMembers() {
    if (!current() || detailBusy || !detail?.members.next) return;
    const id = detail.room.room_id, request = inspecting.current, offset = detail.members.next;
    setDetailBusy(true);
    try {
      const next = checkedDetail(await requestApi('/admin/rooms/' + encodeURIComponent(id) + '?memberFrom=' + offset), id);
      if (current() && request === inspecting.current && id === selected.current) setDetail((old: any) => old?.room.room_id === id ? { ...next, members: { ...next.members, members: [...new Set([...old.members.members, ...next.members.members])] } } : old);
    } catch (e: any) { if (current() && request === inspecting.current) setError(e.message); }
    finally { if (current() && request === inspecting.current) setDetailBusy(false); }
  }
  async function block() {
    if (!current() || mutating || !detail || confirmation !== detail.room.room_id) return;
    const id = detail.room.room_id, request = inspecting.current; setMutating(true); setError('');
    try {
      await requestApi('/admin/rooms/' + encodeURIComponent(id) + '/block', { block: !detail.blocked, confirmation }, 'PUT');
      if (!current() || request !== inspecting.current || selected.current !== id) return;
      await inspect(id); if (current() && selected.current === id) toast.success('Room join policy updated');
    } catch (e: any) { if (current() && selected.current === id) setError(e.message); }
    finally { if (current()) setMutating(false); }
  }
  if (stale || !current()) return <p className="connect-error" role="alert">Your account changed. Reopen room administration.</p>;
  return <div className="product-section"><form className="admin-toolbar" onSubmit={e => { e.preventDefault(); if (page) setPage(0); else void load(); }}>
    <input aria-label="Search rooms" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Room name or ID"/><button className="secondary-button" disabled={listBusy || mutating}>Search</button></form>
    {error && !detail && <p className="connect-error" role="alert">{error}</p>}{detailBusy && !detail && <p role="status">Loading room details…</p>}
    <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Room</th><th>Type</th><th>Members</th><th>Actions</th></tr></thead><tbody>{data?.rooms?.map((r: any) => <tr key={r.room_id}>
      <td>{r.name || r.room_id}</td><td>{r.room_type === 'm.space' ? 'Server' : 'Conversation'}</td><td>{r.joined_members}</td><td><button className="secondary-button" disabled={mutating} onClick={() => void inspect(r.room_id)}>Inspect</button></td>
    </tr>)}</tbody></table></div><div className="product-actions"><button className="secondary-button" disabled={listBusy || mutating || !page} onClick={() => setPage(Math.max(0, page - 50))}>Previous</button><span>{data?.total_rooms ?? '—'} rooms</span><button className="secondary-button" disabled={listBusy || mutating || data?.next_batch == null} onClick={() => setPage(Number(data.next_batch))}>Next</button></div>
    <Dialog open={!!detail} onOpenChange={open => { if (!open && !mutating) { inspecting.current++; selected.current = ''; setDetail(null); setDetailBusy(false); } }}><DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>{detail?.room?.name || 'Room administration'}</DialogTitle><DialogDescription>Inspect native room metadata, relationships and membership, and control new joins.</DialogDescription></DialogHeader>
      {detail && <><code>{detail.room.room_id}</code><p>{detail.room.topic}</p><p>Encryption: {detail.room.encryption || 'Disabled'}<br/>New joins: {detail.blocked ? 'Blocked' : 'Allowed by room policy'}</p>
        <AdminRoomHierarchy key={detail.room.room_id} roomId={detail.room.room_id} onInspect={id => { if (!mutating) void inspect(id); }}/>
        <details><summary>Members ({detail.members.total})</summary>{detail.members.members.map((id: string) => <p key={id}>{id}</p>)}{detail.members.next && <button type="button" className="secondary-button" disabled={detailBusy || mutating} onClick={() => void moreMembers()}>Load more members</button>}</details>
        <form className="dialog-form" onSubmit={e => { e.preventDefault(); void block(); }}><p>Existing members keep their access. Blocking prevents new joins.</p><Field label="Type the room ID to confirm"><input value={confirmation} onChange={e => setConfirmation(e.target.value)} required/></Field><button className="primary-button" disabled={mutating || detailBusy || confirmation !== detail.room.room_id}>{detail.blocked ? 'Unblock new joins' : 'Block new joins'}</button></form>
        {error && <p className="connect-error" role="alert">{error}</p>}</>}
    </DialogContent></Dialog></div>;
}
