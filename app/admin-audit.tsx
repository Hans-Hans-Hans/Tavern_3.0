import { useEffect, useState } from 'react';
import { requestApi } from '@/lib/api';
import { Field } from './auth-gateway';

type Filters = { actor: string; action: string; target: string; since: string; until: string; security: boolean };
const empty: Filters = { actor: '', action: '', target: '', since: '', until: '', security: false };
export function AdminAudit() {
  const [filters, setFilters] = useState(empty), [applied, setApplied] = useState(empty), [pages, setPages] = useState<number[]>([]);
  const [result, setResult] = useState<{ events: any[]; next?: number } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let live = true; setBusy(true); setError('');
    const query = new URLSearchParams();
    for (const key of ['actor', 'action', 'target'] as const) if (applied[key].trim()) query.set(key, applied[key].trim());
    for (const key of ['since', 'until'] as const) if (applied[key]) query.set(key, String(Math.floor(new Date(applied[key]).getTime() / 1000)));
    if (applied.security) query.set('security', 'true');
    if (pages.length) query.set('before', String(pages.at(-1)));
    void requestApi('/admin/audit?' + query).then(value => { if (live) setResult(value); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [applied, pages]);
  return <section className='product-section'><form className='dialog-form' onSubmit={event => { event.preventDefault(); setPages([]); setApplied({ ...filters }); }}><label className='check-label'><input type='checkbox' checked={filters.security} onChange={e => setFilters({ ...filters, security: e.target.checked })}/>Security events only</label><div className='product-actions'>{(['actor', 'action', 'target'] as const).map(key => <Field key={key} label={key[0].toUpperCase() + key.slice(1) + ' (exact match)'}><input maxLength={255} value={filters[key]} onChange={e => setFilters({ ...filters, [key]: e.target.value })}/></Field>)}</div><div className='product-actions'><Field label='From (local time)'><input type='datetime-local' value={filters.since} onChange={e => setFilters({ ...filters, since: e.target.value })}/></Field><Field label='Until (local time)'><input type='datetime-local' value={filters.until} onChange={e => setFilters({ ...filters, until: e.target.value })}/></Field></div><button className='secondary-button' disabled={busy}>Apply filters</button></form>{error && <p role='alert' className='connect-error'>{error}</p>}{busy && <p role='status'>Loading audit events…</p>}{result && <><div className='admin-table-wrap'><table className='admin-table'><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>{result.events.map(event => <tr key={event.id}><td>{new Date(event.created * 1000).toLocaleString()}</td><td>{event.actor}</td><td>{event.action}</td><td>{event.target}</td><td>{event.detail}</td></tr>)}</tbody></table></div>{!result.events.length && <p>No events match these filters.</p>}<div className='product-actions'><button className='secondary-button' disabled={busy || !pages.length} onClick={() => setPages(previous => previous.slice(0, -1))}>Newer events</button><span>Page {pages.length + 1}</span><button className='secondary-button' disabled={busy || !result.next} onClick={() => setPages(previous => [...previous, result.next!])}>Older events</button></div></>}<p>Account and administration events contain no passwords, verification codes, session tokens, or message content. Repeated rejected requests are sampled once per minute for each source and failure type.</p></section>;
}
