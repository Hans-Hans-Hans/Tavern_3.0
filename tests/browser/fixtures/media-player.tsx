import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MediaViewer } from '../../../app/media-viewer';
import { createMediaPreview } from '../../../lib/media-processing';
import '../../../app/globals.css';
import '../../../app/product.css';

async function recording() {
  const response = await fetch(new URL('./recording.webm', import.meta.url));
  if (!response.ok) throw new Error('The local test video is unavailable.');
  return new File([await response.blob()], 'Recording.webm', { type: 'video/webm' });
}
function Fixture() {
  const [open, setOpen] = useState(false), [index, setIndex] = useState(0), [ready, setReady] = useState(false), [error, setError] = useState('');
  const w = window as any;
  async function prepare() {
    try { w.fixtureVideo = await recording(); w.fixturePreview = await createMediaPreview(w.fixtureVideo); setReady(true); } catch (error) { setError(String(error)); }
  }
  const items = [{ id: 'video', name: 'Recording.webm', size: 100, type: 'video/webm' }, { id: 'other', name: 'Other file', size: 10 }];
  return <main><button onClick={() => void prepare()}>Prepare local recording</button><button disabled={!ready} onClick={() => { setIndex(0); setOpen(true); }}>Open video</button><p role="status">{ready ? 'Recording ready' : error}</p>{open && <MediaViewer items={items} index={index} onChange={setIndex} onClose={() => setOpen(false)} />}</main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>);
