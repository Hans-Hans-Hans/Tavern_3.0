import React from 'react';
import { createRoot } from 'react-dom/client';
import { RoomRemovalSettings, RoomRemovalHistory } from '../../../app/room-removal';
import '../../../app/globals.css';
export function mountFixture() {
  (window as any).account = {}; (window as any).client = {};
  const root = createRoot(document.getElementById('root')!);
  root.render(<main style={{ width: 'min(680px, 100%)', margin: 'auto', padding: 16 }}>
    <button onClick={() => root.unmount()}>Close panel</button>
    {location.search.includes('history') ? <RoomRemovalHistory/> : <RoomRemovalSettings roomId='!voice:local' onChanged={() => { (window as any).completed = true; }}/>}</main>);
}
