import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThreadEvent } from 'matrix-js-sdk';
import { ThreadTools } from '../../../app/thread-tools';
import { readThreadEvents, loadOlderThreadHistory, threadHistoryHasOlder } from '../../../lib/thread-history';
import { readJoinedRoom } from '../../../lib/room-read-scope';
import { threadHistoryFixture } from '../../fixtures/thread-history.mjs';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any, f = threadHistoryFixture({ empty: location.search.includes('empty') });
  const listeners = new Set<() => void>(), notify = () => { for (const listener of listeners) listener(); };
  f.room.on(ThreadEvent.Update, notify); w.fixtureHistory = f; w.fixtureHistoryListeners = listeners;
  w.fixtureInitialRootLoaded = !!f.room.findEventById(f.rootId);
  w.fixtureHistoryOlder = () => readJoinedRoom(f.client, f.room, f.current, () => loadOlderThreadHistory(f.client, f.room, f.rootId, f.root, f.current), () => notify());
  w.fixtureHistoryHasOlder = () => threadHistoryHasOlder(f.client, f.room, f.rootId);
  function Fixture() {
    const [replies, setReplies] = useState<{ id: string; body: string; author_id: string }[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
    async function load() {
      const result = await readJoinedRoom(f.client, f.room, f.current, async () => {
        const events = await readThreadEvents(f.client, f.room, f.rootId, f.root, f.current);
        await Promise.all(events.map(event => f.client.decryptEventIfNeeded(event))); return events;
      }, events => events.filter(event => event.getId() !== f.rootId).map(event => ({ id: event.getId()!, body: event.getContent().body, author_id: event.getSender()! })));
      setReplies(result); setLoading(false);
    }
    useEffect(() => { void load().catch(failure => { setError(failure.message); setLoading(false); }); }, []);
    return <main style={{ padding: 24, maxWidth: 700 }}><h1>Historical discussion</h1>
      <button onClick={() => { f.state.failPage = true; }}>Deny next history page</button><button onClick={() => { f.state.failPage = false; }}>Allow history again</button>
      <button onClick={() => { f.state.pageGate = new Promise(resolve => { w.fixtureReleaseHistory = resolve; }); }}>Pause history page</button><button onClick={() => { f.state.current = false; notify(); }}>Change account</button>
      {loading ? <p role='status'>Loading existing thread history…</p> : <><ThreadTools roomId={f.room.roomId} rootId={f.rootId} authorId='@alice:local' replies={replies} onChanged={load}/><ul aria-label='Loaded thread replies'>{replies.map(reply => <li key={reply.id}>{reply.body}</li>)}</ul>{!replies.length && <p>No replies yet.</p>}</>}{error && <p role='alert'>{error}</p>}
    </main>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
