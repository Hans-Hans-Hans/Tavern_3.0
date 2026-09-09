import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { requestApi } from '@/lib/api';
import './admin-logs.css';

type Row = { timestamp: string | null; component: string; severity: string; message: string };
type Logs = { available: boolean; reason?: string; rows?: Row[]; components?: string[]; unavailable?: string[]; capturedAt?: string; truncated?: boolean };
type Sample = { component: string; state: string; available: boolean; reason?: string; cpuPercent?: number | null; memoryBytes?: number | null; memoryLimitBytes?: number | null; memoryPercent?: number | null; pids?: number | null; receivedBytes?: number | null; sentBytes?: number | null; retention?: { driver: string | null; maxSize: string | null; maxFiles: string | null } };
type Performance = { available: boolean; reason?: string; components?: Sample[]; capturedAt?: string; operationQueueDepth?: number; checks?: { component: string; status: string; detail: string; latencyMs?: number }[] };
const bytes = (value?: number | null) => value == null ? 'Unavailable' : value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GiB' : value >= 1024 ** 2 ? (value / 1024 ** 2).toFixed(1) + ' MiB' : (value / 1024).toFixed(1) + ' KiB';

export function AdminLogs() {
  const [logs, setLogs] = useState<Logs | null>(null), [performance, setPerformance] = useState<Performance | null>(null);
  const [component, setComponent] = useState('all'), [severity, setSeverity] = useState('ALL'), [minutes, setMinutes] = useState('15'), [limit, setLimit] = useState('200'), [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [auto, setAuto] = useState(false);
  const generation = useRef(0), pending = useRef(false);
  async function refresh() {
    if (pending.current) return; pending.current = true; const mine = ++generation.current; setBusy(true); setError('');
    const filters = new URLSearchParams({ component, severity, minutes, limit, search });
    const results = await Promise.allSettled([requestApi<Logs>('/admin/logs?' + filters), requestApi<Performance>('/admin/performance')]);
    if (mine !== generation.current) return;
    if (results[0].status === 'fulfilled') setLogs(results[0].value);
    if (results[1].status === 'fulfilled') setPerformance(results[1].value);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failure) setError(failure.reason?.message || 'Observations could not be refreshed.');
    pending.current = false; setBusy(false);
  }
  useEffect(() => { void refresh(); return () => { generation.current++; pending.current = false; }; }, []);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    return () => clearInterval(timer);
  }, [auto, component, severity, minutes, limit, search]);
  function exportLogs() {
    if (!logs?.rows) return;
    const blob = new Blob([JSON.stringify(logs, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'tavern-logs-' + new Date().toISOString().replaceAll(':', '-') + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className='admin-observations'>
    <div className='admin-observation-heading'><div><h2>Logs & performance</h2><p>Recent service output and measured container resources.</p></div><button className='secondary-button' disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} className={busy ? 'spin' : ''}/>Refresh</button></div>
    {error && <p className='connect-error' role='alert'>{error} Previously loaded observations remain visible.</p>}
    <label className='check-label'><input type='checkbox' checked={auto} onChange={event => setAuto(event.target.checked)}/>Refresh every 30 seconds while this page is visible</label>
    {performance?.checks && <div className='admin-measurements'>{performance.checks.map(check => <div key={check.component}><strong>{check.component}</strong><span>{check.latencyMs == null ? check.status : check.latencyMs.toFixed(2) + ' ms'}</span><small>{check.detail}</small></div>)}</div>}
    {performance && !performance.available && <p className='notice'>{performance.reason}</p>}
    {performance?.available && <><div className='admin-observation-heading'><h3>Container resources</h3><small>Measured {performance.capturedAt ? new Date(performance.capturedAt).toLocaleTimeString() : 'now'} · Operations waiting or running: {performance.operationQueueDepth ?? 'Unavailable'}</small></div><div className='admin-resource-scroll'><table className='admin-resource-table'><thead><tr><th>Component</th><th>State</th><th>CPU</th><th>Memory</th><th>Processes</th><th>Network received / sent</th></tr></thead><tbody>{performance.components?.map(sample => <tr key={sample.component}><th>{sample.component}</th><td>{sample.state}</td>{sample.available ? <><td>{sample.cpuPercent == null ? 'Unavailable' : sample.cpuPercent.toFixed(1) + '%'}</td><td>{bytes(sample.memoryBytes)}{sample.memoryPercent != null && <small>{sample.memoryPercent.toFixed(1)}% of {bytes(sample.memoryLimitBytes)}</small>}</td><td>{sample.pids ?? 'Unavailable'}</td><td>{bytes(sample.receivedBytes)} / {bytes(sample.sentBytes)}</td></> : <td colSpan={4}>{sample.reason}</td>}</tr>)}</tbody></table></div><p className='login-help'>CPU is measured across allocated cores and can exceed 100%. Network values are cumulative container counters. Missing samples are not shown as zero.</p></>}
    <form className='admin-log-filters' onSubmit={event => { event.preventDefault(); void refresh(); }}>
      <label>Component<select value={component} onChange={event => setComponent(event.target.value)}><option value='all'>All Tavern services</option>{(logs?.components || performance?.components?.map(sample => sample.component) || []).map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      <label>Severity<select value={severity} onChange={event => setSeverity(event.target.value)}>{['ALL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'UNKNOWN'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Time window<select value={minutes} onChange={event => setMinutes(event.target.value)}>{[['5', '5 minutes'], ['15', '15 minutes'], ['60', '1 hour'], ['360', '6 hours'], ['1440', '24 hours']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Maximum lines<select value={limit} onChange={event => setLimit(event.target.value)}>{[100, 200, 500, 1000, 2000].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className='admin-log-search'>Search message<input value={search} maxLength={120} onChange={event => setSearch(event.target.value)} placeholder='Filter recent service output'/></label><button className='primary-button' disabled={busy}>Apply filters</button>
    </form>
    {logs && !logs.available && <p className='notice'>{logs.reason}</p>}
    {logs?.available && <><div className='admin-observation-heading'><p>{logs.rows?.length || 0} matching lines · {logs.capturedAt ? new Date(logs.capturedAt).toLocaleTimeString() : 'Latest snapshot'}</p><button className='secondary-button' disabled={!logs.rows?.length} onClick={exportLogs}><Download size={16}/>Export this snapshot</button></div>{logs.truncated && <p className='notice'>The result reached its size or line limit. Narrow the time window or select one component.</p>}{!!logs.unavailable?.length && <p role='status'>Logs unavailable for: {logs.unavailable.join(', ')}. Their logging driver may not support Docker log retrieval.</p>}<div className='admin-log-output' role='region' aria-label='Service log results'>{!logs.rows?.length && <p>No log lines match these filters.</p>}{logs.rows?.map((row, index) => <article className='admin-log-row' key={index}><time>{row.timestamp ? new Date(row.timestamp).toLocaleString() : 'No timestamp'}</time><span>{row.component}</span><strong className={'log-' + row.severity.toLowerCase()}>{row.severity}</strong><pre>{row.message}</pre></article>)}</div><p className='login-help'>Only recent, retained container output is searched. Common credential fields are masked; review diagnostic text before sharing an export.</p></>}
    {performance?.components && <details><summary>Configured log retention</summary><ul>{performance.components.map(sample => <li key={sample.component}>{sample.component}: {sample.retention?.driver || 'Daemon default'} · {sample.retention?.maxFiles || 'Unspecified'} files × {sample.retention?.maxSize || 'unspecified size'}</li>)}</ul><p>Set LOG_MAX_SIZE and LOG_MAX_FILES in the deployment environment and recreate the affected containers to change rotation.</p></details>}
  </section>;
}
