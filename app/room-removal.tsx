import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner, requestApi } from '@/lib/api';
import { getMatrixClient } from '@/lib/matrix';

type Removal = { id: string; roomId: string; kind: 'server' | 'channel'; name: string; phase: 'review' | 'ready' | 'native_pending' | 'metadata' | 'attention' | 'complete'; issue: string; completed: number; targets: { id: string; name: string; kind: string; members: number; state: string }[] };
const phaseLabels = { review: 'Review required', ready: 'Ready to continue', native_pending: 'Removing room', metadata: 'Updating channel lists', attention: 'Needs attention', complete: 'Deleted' };
const stateLabels: Record<string, string> = { ready: 'Waiting', submitted: 'Removal requested', purged: 'Updating channel lists', complete: 'Deleted' };

function useOwner() {
  const [owner] = useState(() => ({ account: accountArtworkOwner(), client: getMatrixClient() })), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return () => alive.current && owner.account === accountArtworkOwner() && owner.client === getMatrixClient();
}

/** Status stays available in account settings after a removed room leaves sync. */
export function RoomRemovalHistory() {
  const current = useOwner(), [jobs, setJobs] = useState<Removal[]>([]), [selected, setSelected] = useState<Removal | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function reload() {
    if (!current()) return;
    setBusy(true); setError('');
    try { const data = await requestApi<{ operations: Removal[] }>('/room-removals'); if (current()) setJobs(data.operations); }
    catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  useEffect(() => { void reload(); }, []);
  return <section className='settings-section' aria-label='Server and channel deletions'><h3>Server and channel deletions</h3>
    <p>Review or resume your deletion requests here, including requests for rooms that have left your sidebar.</p>
    <button className='secondary-button' disabled={busy} onClick={() => void reload()}>Refresh deletion list</button>
    {error && <p role='alert'>{error}</p>}
    {!busy && !jobs.length && <p>No deletion requests.</p>}
    <ul>{jobs.map(job => <li key={job.id}><button className='secondary-button' onClick={() => setSelected(job)}>{job.name} · {phaseLabels[job.phase]}</button></li>)}</ul>
    {selected && <RemovalProgress key={selected.id} initial={selected} onChanged={() => { void reload(); }}/>}</section>;
}

export function RoomRemovalSettings({ roomId, onChanged }: { roomId: string; onChanged: () => unknown }) {
  return <RemovalEditor key={roomId} roomId={roomId} onChanged={onChanged}/>;
}
function RemovalEditor({ roomId, onChanged }: { roomId: string; onChanged: () => unknown }) {
  const current = useOwner(), [job, setJob] = useState<Removal | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState('');
  useEffect(() => { void requestApi<{ operation: Removal | null }>('/rooms/' + encodeURIComponent(roomId) + '/removal').then(data => { if (current()) setJob(data.operation); }).catch(failure => { if (current()) setError(failure.message); }).finally(() => { if (current()) setBusy(false); }); }, []);
  async function review() {
    if (!current() || busy) return;
    setBusy(true); setError('');
    try { const value = await requestApi<Removal>('/rooms/' + encodeURIComponent(roomId) + '/removal-review', {}); if (current()) setJob(value); }
    catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  const pending = job && !['review', 'complete'].includes(job.phase);
  return <section className='settings-section' aria-label='Delete server or channel'><h3>Delete permanently</h3>
    <p>Only the server owner can delete its channels or the server. Review the exact rooms and affected memberships before confirming.</p>
    {!pending && <button className='secondary-button' disabled={busy} onClick={() => void review()}>Review permanent deletion</button>}
    {error && <p role='alert' className='connect-error'>{error}</p>}
    {job && <RemovalProgress key={job.id} initial={job} onUpdate={setJob} onChanged={onChanged}/>}</section>;
}

function RemovalProgress({ initial, onChanged, onUpdate }: { initial: Removal; onChanged: () => unknown; onUpdate?: (job: Removal) => void }) {
  const current = useOwner(), [job, setJob] = useState(initial), [confirmation, setConfirmation] = useState(''), [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false), [error, setError] = useState(''), lock = useRef(false);
  const path = '/room-removals/' + job.id;
  async function action(kind: 'confirm' | 'continue' | 'refresh', retry = false) {
    if (!current() || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const updated = await requestApi<Removal>(path + (kind === 'refresh' ? '' : '/' + kind), kind === 'refresh' ? undefined : kind === 'confirm' ? { confirmation } : { retry });
      if (!current()) return;
      setJob(updated); onUpdate?.(updated);
      setRunning(kind !== 'refresh' && !['review', 'attention', 'complete'].includes(updated.phase));
      if (updated.phase === 'complete') { setConfirmation(''); await onChanged(); }
    } catch (failure) { if (current()) { setError((failure as Error).message); setRunning(false); } }
    finally { lock.current = false; if (current()) setBusy(false); }
  }
  useEffect(() => {
    if (!running || busy) return;
    const timer = setTimeout(() => { void action('continue'); }, 2000);
    return () => clearTimeout(timer);
  }, [running, busy, job]);
  return <div className='dialog-form' aria-label={'Deletion of ' + job.name}>
    <h4>{job.name}</h4><p role='status'>{phaseLabels[job.phase]} · {job.completed} of {job.targets.length} rooms deleted</p>
    <ul className='removal-targets'>{job.targets.map(target => <li key={target.id}><strong>{target.name}</strong><small>{target.kind} · {target.members} joined or invited at review · {stateLabels[target.state] || 'Pending'}</small></li>)}</ul>
    {job.phase === 'review' ? <form className='dialog-form' onSubmit={event => { event.preventDefault(); void action('confirm'); }}>
      <p>This removes these rooms and their history from this server and removes every membership. A server deletion includes the listed channels. This cannot be undone; copies already downloaded to devices or backups remain.</p>
      <label>Type {job.name} to confirm<input value={confirmation} autoComplete='off' maxLength={255} onChange={event => setConfirmation(event.target.value)}/></label>
      <button className='primary-button delete-confirm' disabled={busy || confirmation !== job.name}>Delete permanently</button>
    </form> : job.phase !== 'complete' ? <>
      <p>Keep this panel open to continue. Closing it pauses further steps; return here or open Account &amp; security → Server and channel deletions to resume. A removal already sent to the server continues in the background.</p>
      {!running && <button className='primary-button delete-confirm' disabled={busy} onClick={() => void action('continue', true)}>Resume deletion</button>}
    </> : <p>Room removal and channel-list cleanup are confirmed.</p>}
    {job.issue && <p role='alert'>{job.issue}</p>}{error && <p role='alert' className='connect-error'>{error}</p>}
    {!running && job.phase !== 'review' && <button className='secondary-button' disabled={busy} onClick={() => void action('refresh')}>Refresh saved status</button>}
  </div>;
}
