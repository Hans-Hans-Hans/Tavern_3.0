import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageHistoryPanel } from '../../../app/message-history';
import { JoinedMessageHistory } from '../../../lib/message-history';
import { setAccountDevice } from '../../../lib/api';
import { messageHistoryFixture } from '../../fixtures/message-history.mjs';
import { mountFixture } from './private-workspace';
import '../../../app/globals.css';

const w = window as any, query = new URLSearchParams(location.search);
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const image = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
w.historyReaders = []; w.historyCalls = []; w.urls = []; w.revoked = [];
const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = blob => { const url = createURL(blob); w.urls.push(url); return url; };
URL.revokeObjectURL = url => { w.revoked.push(url); revokeURL(url); };

function capture(reader: any) {
  const dispose = reader.dispose.bind(reader); reader.disposals = 0;
  reader.dispose = () => { reader.disposals++; dispose(); };
  w.historyReaders.push(reader); return reader;
}

if (query.has('workspace')) {
  // Preserve the actual Workspace/Sheet/message renderer. Only the Matrix
  // adapter is controlled here; the separate panel fixture uses the real SDK.
  mountFixture();
  const previous = w.matrixBoundary;
  const historical = { ...w.publicMessage, id: '$historical', body: 'Historical bookmarked message', saved: 1,
    attachments: [{ id: 'history-image', name: 'history.png', type: 'image/png', size: image.length }] };
  const neighbour = { ...historical, id: '$neighbour', body: 'Surrounding historical message', saved: 0,
    attachments: [{ id: 'neighbour-image', name: 'neighbour.png', type: 'image/png', size: image.length }] };
  w.historical = historical;
  w.matrixBoundary = (name: string, args: any[]) => {
    if (name === 'matrixApi' && args[0] === 'saved') return Promise.resolve({ messages: [historical], hasMore: false });
    if (name === 'resolveMatrixMessage' && args[1] === '$historical') { w.resolved.push(args); return Promise.resolve(historical); }
    if (name === 'resolveMatrixMessage' && args[1] === '$thread-reply') { w.resolved.push(args); return Promise.resolve({ ...historical, id: '$thread-reply', parent_id: '$source' }); }
    if (name === 'matrixFileBlob') { w.historyCalls.push(['media', args[0].id]); return Promise.resolve(new Blob([image], { type: 'image/png' })); }
    if (name === 'createMatrixMessageHistory') {
      w.historyCalls.push(['open', args[0], args[1]]);
      const value = { messages: [historical, neighbour], older: false, newer: false, atLive: false, limited: false, targetPresent: true, emptyPage: false };
      return capture({ dispose() {}, async load() { if (w.deferHistory) await new Promise<void>(resolve => { w.releaseHistory = resolve; }); return value; }, async refresh() { return value; }, async page() { throw new Error('Unexpected fixture page'); } });
    }
    return previous(name, args);
  };
} else {
  const f = w.historyFixture = messageHistoryFixture();
  w.historyListenerBaseline = f.listenerCount();
  w.listeners = new Set(); w.notify = () => w.listeners.forEach((listener: () => void) => listener());
  w.replaceAccount = () => { setAccountDevice('B'); setAccountDevice('A'); w.notify(); };
  w.historyFixture.state.missingKey = query.has('missing-key');
  if (query.has('hold')) { const wait = gate(); f.state[query.get('hold') + 'Gate'] = wait.promise; w.release = wait.release; }
  w.matrixBoundary = (name: string, args: any[]) => {
    if (name === 'getMatrixClient') return f.client;
    if (name === 'onMatrixUpdate') { w.listeners.add(args[0]); return () => w.listeners.delete(args[0]); }
    if (name === 'createMatrixMessageHistory') return capture(new JoinedMessageHistory({ ...f, eventId: args[1], current: () => f.current() && args[2]() }));
    return Promise.resolve();
  };
  function Panel() {
    const [open, setOpen] = useState(true); w.reopen = () => setOpen(true);
    return <div style={{ height: 650, maxHeight: '100dvh', display: 'flex' }}>{open ? <MessageHistoryPanel roomId={f.roomId} eventId={f.eventId} isCurrent={() => f.current()}
      onClose={() => setOpen(false)} onLatest={() => { w.latest = true; setOpen(false); }}
      renderMessage={(message: any) => <article>{message.body}</article>}/> : <p>Context closed</p>}</div>;
  }
  createRoot(document.getElementById('root')!).render(query.has('strict') ? <React.StrictMode><Panel/></React.StrictMode> : <Panel/>);
  w.ready = true;
}
