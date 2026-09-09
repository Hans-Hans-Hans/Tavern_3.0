import { useEffect, useRef, useState } from 'react';
import { requestApi } from '@/lib/api';
import { onMatrixUpdate } from '@/lib/matrix';
import { roomReportLocations } from '@/lib/room-reports';
import { Field } from './auth-gateway';

type Report = { id: number; roomId: string; eventId: string; targetId: string; kind: string; reason: string; evidence: string; reporter: string; createdAt: number; updatedAt: number; status: string; note: string; reviewer: string | null; revision: number };
type Page = { reports: Report[]; next: number | null };
const statuses = ['open', 'reviewing', 'resolved', 'dismissed'];

export function RoomReportReview({ roomId }: { roomId: string }) {
  const [scope, setScope] = useState(roomId), [status, setStatus] = useState('open'), [pages, setPages] = useState<number[]>([]), [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<Page | null>(null), [selected, setSelected] = useState<Report | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [notice, setNotice] = useState('');
  const [, redraw] = useState(0); useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  const locations = roomReportLocations(roomId), effectiveScope = locations.some(room => room.id === scope) ? scope : locations[0]?.id || '';
  const currentScope = useRef(effectiveScope); currentScope.current = effectiveScope;
  useEffect(() => { setScope(roomId); setPages([]); setSelected(null); setNotice(''); }, [roomId]);
  useEffect(() => { setSelected(null); setPages([]); setConflict(false); setNotice(''); }, [effectiveScope, status]);
  useEffect(() => {
    const check = () => { if (!document.hidden && !busy) setRefresh(value => value + 1); };
    const timer = window.setInterval(check, 60000); window.addEventListener('focus', check);
    return () => { clearInterval(timer); window.removeEventListener('focus', check); };
  }, [busy]);
  useEffect(() => {
    setData(null); if (!effectiveScope) { setSelected(null); return; }
    let live = true; setBusy(true); setError('');
    const query = new URLSearchParams({ roomId: effectiveScope, status }); if (pages.length) query.set('before', String(pages.at(-1)));
    void requestApi<Page>('/moderation/reports?' + query).then(value => { if (live) setData(value); }).catch(e => { if (live) { setError(e.message); if (e.status === 401 || e.status === 403) setSelected(null); } }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [effectiveScope, status, pages, refresh]);
  if (!effectiveScope) return <p>Room report review requires current membership, native moderation power and the “Review reports explicitly shared with room moderators” role permission.</p>;
  async function open(identity: number) {
    setBusy(true); setError(''); setConflict(false); setNotice('');
    try { const value = await requestApi<Report>('/moderation/reports/' + identity + '?' + new URLSearchParams({ roomId: effectiveScope })); if (currentScope.current === effectiveScope) setSelected(value); }
    catch (e: any) { if (currentScope.current === effectiveScope) { setError(e.message); setSelected(null); } } finally { setBusy(false); }
  }
  async function save() {
    if (!selected || busy || conflict) return;
    setBusy(true); setError(''); setNotice('');
    try { await requestApi('/moderation/reports/' + selected.id, { roomId: effectiveScope, status: selected.status, note: selected.note, revision: selected.revision }, 'PUT'); setSelected(null); setNotice('Room moderator review saved.'); setRefresh(value => value + 1); }
    catch (e: any) { setError(e.message); if (e.status === 409) setConflict(true); if (e.status === 401 || e.status === 403) { setData(null); setSelected(null); } }
    finally { setBusy(false); }
  }
  return <section className='product-section'><h3>Room moderator reports</h3><p>This queue contains reports explicitly shared with this room’s moderators. Instance administrator reports and their private review notes remain separate. Supplied evidence does not grant access to encrypted message history.</p>
    <div className='product-actions'><Field label='Report location'><select disabled={busy} value={effectiveScope} onChange={event => setScope(event.target.value)}>{locations.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></Field><Field label='Room report status'><select disabled={busy} value={status} onChange={event => { setStatus(event.target.value); setPages([]); }}>{[...statuses, 'all'].map(value => <option key={value}>{value}</option>)}</select></Field><button className='secondary-button' disabled={busy} onClick={() => setRefresh(value => value + 1)}>Refresh room reports</button></div>
    {busy && <p role='status'>Loading room reports…</p>}{error && <p role='alert' className='connect-error'>{error}</p>}{notice && <p role='status'>{notice}</p>}
    {data && <>{data.reports.map(report => <article className='product-section' key={report.id}><button className='secondary-button' disabled={busy} onClick={() => void open(report.id)}>Review shared report #{report.id}</button><p>{report.kind} · {report.status} · {new Date(report.createdAt).toLocaleString()}</p><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{report.reason}</p><small>Submitted by {report.reporter}</small></article>)}{!data.reports.length && <p>No shared room reports match this status.</p>}<div className='product-actions'><button className='secondary-button' disabled={busy || !pages.length} onClick={() => { setPages(value => value.slice(0, -1)); setSelected(null); }}>Newer shared reports</button><span>Page {pages.length + 1}</span><button className='secondary-button' disabled={busy || !data.next} onClick={() => { setPages(value => [...value, data.next!]); setSelected(null); }}>Older shared reports</button></div></>}
    {selected && <form className='dialog-form' aria-label='Room report review' onSubmit={event => { event.preventDefault(); void save(); }}><h4>Review shared report #{selected.id}</h4><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.reason}</p>{selected.evidence && <blockquote style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.evidence}</blockquote>}<p>Reporter: {selected.reporter}<br/>Room: {selected.roomId}<br/>Event: {selected.eventId || 'None supplied'}<br/>Target: {selected.targetId || 'None supplied'}</p><p>Last reviewed by {selected.reviewer || 'no moderator yet'}.</p><Field label='Moderator review status'><select disabled={busy || conflict} value={selected.status} onChange={event => setSelected({ ...selected, status: event.target.value })}>{statuses.map(value => <option key={value}>{value}</option>)}</select></Field><Field label='Room moderator note'><textarea disabled={busy || conflict} maxLength={2000} value={selected.note} onChange={event => setSelected({ ...selected, note: event.target.value })}/></Field><p className='login-help'>This note is visible to currently authorized room reviewers. The reporter sees the review status; this note and the platform’s private notes remain separate.</p>{conflict && <p>Another review was saved while you were editing. Copy any draft text you need before refreshing this report.</p>}<div className='product-actions'><button className='primary-button' disabled={busy || conflict}>Save room review</button>{conflict && <button type='button' className='secondary-button' disabled={busy} onClick={() => void open(selected.id)}>Refresh selected report</button>}<button type='button' className='secondary-button' disabled={busy} onClick={() => { setSelected(null); setConflict(false); }}>Close room review</button></div></form>}
  </section>;
}
