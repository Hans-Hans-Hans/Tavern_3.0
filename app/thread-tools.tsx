import { useEffect, useMemo, useRef, useState } from 'react';
import { discoverMatrixThreadParticipants, getMatrixClient, loadThreadHistory, onMatrixUpdate, threadHasOlder } from '@/lib/matrix';
import { accountArtworkOwner } from '@/lib/api';
import { loadedThreadParticipants, type ThreadParticipantSnapshot } from '@/lib/thread-participants';
import { readThreadNotification, saveThreadNotification, type ThreadNotificationMode } from '@/lib/thread-preferences';

export function ThreadTools({ roomId, rootId, replies, onChanged }: { roomId: string; rootId: string; authorId: string; replies: { author_id: string }[]; onChanged: () => Promise<unknown> }) {
  const [revision, refresh] = useState(0);
  useEffect(() => onMatrixUpdate(() => refresh(value => value + 1)), []);
  const client = getMatrixClient(), actor = client?.getUserId(), device = client?.getDeviceId(), account = accountArtworkOwner(), room = client?.getRoom(roomId);
  const owner = useMemo(() => ({ client, actor, device, account, room, roomId, rootId }), [client, actor, device, account, room, roomId, rootId]);
  const active = useRef<typeof owner | null>(owner); active.current = owner;
  const stateOwner = useRef(owner);
  const operation = useRef<AbortController | null>(null);
  const pending = useRef<object | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [discovery, setDiscovery] = useState<{ owner: typeof owner; value: ThreadParticipantSnapshot } | null>(null);
  const [query, setQuery] = useState(''), [visible, setVisible] = useState(100);
  const current = () => active.current === owner && getMatrixClient() === client && client?.getUserId() === actor && client?.getDeviceId() === device && accountArtworkOwner() === account && client?.getRoom(roomId) === room && room?.getMyMembership() === 'join';
  useEffect(() => {
    active.current = owner; stateOwner.current = owner; pending.current = null;
    setBusy(false); setError(''); setNotice(''); setDiscovery(null); setQuery(''); setVisible(100);
    return () => { active.current = null; operation.current?.abort(); operation.current = null; pending.current = null; };
  }, [owner]);
  const loaded = useMemo(() => {
    try { return { value: client && room ? loadedThreadParticipants(client, room, rootId, current) : null, error: '' }; }
    catch (failure) { return { value: null, error: (failure as Error).message }; }
  }, [owner, replies, revision, discovery]);
  const snapshot = current() ? loaded.value : null;
  const ownState = stateOwner.current === owner && current();
  const participants = snapshot?.userIds || [];
  const matching = participants.filter(id => !ownState || !query || (id + ' ' + (room?.getMember(id)?.name || '')).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  async function run(action: () => Promise<unknown>) {
    if (!current() || pending.current) return;
    const token = {}; pending.current = token;
    setBusy(true); setError('');
    try { await action(); if (current()) await onChanged(); } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (pending.current === token) pending.current = null; if (active.current === owner) setBusy(false); }
  }
  async function discover() {
    if (!current() || pending.current) return;
    const controller = new AbortController(); operation.current = controller; pending.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await discoverMatrixThreadParticipants(roomId, rootId, { signal: controller.signal, onProgress: value => { if (current() && !controller.signal.aborted) setDiscovery({ owner, value }); } });
      if (current() && !controller.signal.aborted) {
        setDiscovery({ owner, value });
        setNotice(value.complete ? 'Reached the beginning of the thread history available to this account.' : 'Loaded 20 pages. Continue to discover earlier participants.');
        await onChanged();
      }
    } catch (failure) {
      if (current()) {
        if ((failure as Error).name === 'AbortError') setNotice('Discovery stopped. The current list may be incomplete.');
        else setError((failure as Error).message);
      }
    } finally {
      if (operation.current === controller) operation.current = null;
      if (pending.current === controller) pending.current = null;
      if (active.current === owner) setBusy(false);
    }
  }
  return <section className='thread-tools'>
    <label>Thread notifications<select value={readThreadNotification(roomId, rootId)} disabled={busy || !current()} onChange={event => void run(() => saveThreadNotification(roomId, rootId, event.target.value as ThreadNotificationMode))}><option value='inherit'>Follow channel settings</option><option value='all'>All replies</option><option value='mentions'>Mentions only</option><option value='nothing'>Mute this thread</option></select></label>
    <p className='login-help'>Applies in Tavern. Channel mutes and Do Not Disturb still take priority.</p>
    <details><summary>{!current() || loaded.error ? 'Participants unavailable' : `${participants.length} participant${participants.length === 1 ? '' : 's'} found`}</summary>
      <p className='login-help'>Authors of the original message and native thread replies available to this account. This is a historical author list, not a separate membership list. Missing encryption keys do not hide verified reply senders.</p>
      <label>Search thread participants<input value={ownState ? query : ''} disabled={!current()} maxLength={200} onChange={event => { setQuery(event.target.value); setVisible(100); }}/></label>
      <ul aria-label='Thread participants'>{matching.slice(0, visible).map(id => { const member = room?.getMember(id); return <li key={id}><strong>{member?.name || id}</strong>{member?.name && member.name !== id && <span> · {id}</span>}<small> — {member?.membership === 'join' ? 'Currently in this conversation' : member?.membership ? 'Not currently joined' : 'Current membership not loaded'}</small></li>; })}</ul>
      {!matching.length && <p>No matching participants in the available replies.</p>}
      {matching.length > visible && <button className='secondary-button' onClick={() => setVisible(count => count + 100)}>Show 100 more participants</button>}
      {snapshot?.complete ? <p>Reached the beginning of available thread history. Deleted, hidden or unavailable history can omit earlier authors.</p> : <p>The participant list is partial. Discovery reads up to 20 pages of 50 events at a time.</p>}
      {busy && operation.current ? <><p role='status'>Discovering participants… {discovery?.owner === owner ? discovery.value.pages : 0} pages checked.</p><button className='secondary-button' onClick={() => operation.current?.abort()}>Stop participant discovery</button></> : !snapshot?.complete && <button className='secondary-button' disabled={busy || !current() || snapshot?.supported === false} onClick={() => void discover()}>{discovery?.owner === owner ? 'Continue participant discovery' : 'Discover earlier participants'}</button>}
      {snapshot?.supported === false && <p>Historical thread discovery is unavailable on this homeserver.</p>}
      {ownState && notice && <p role='status'>{notice}</p>}
    </details>
    {threadHasOlder(roomId, rootId) && <button className='secondary-button' disabled={busy} onClick={() => void run(() => loadThreadHistory(roomId, rootId))}>{busy ? 'Loading replies…' : 'Load 50 earlier replies'}</button>}
    {!current() && <p role='status'>Thread participants are unavailable because your account or room access changed. Reopen this conversation.</p>}
    {ownState && (error || loaded.error) && <p className='connect-error' role='alert'>{error || loaded.error}</p>}
  </section>;
}
