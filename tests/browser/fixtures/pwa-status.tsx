import React from 'react';
import { createRoot } from 'react-dom/client';
import { PwaStatus } from '../../../app/pwa-status';
import '../../../app/globals.css';
export function mountFixture() {
  const w = window as any;
  w.statusState = { online: true, installed: false, installAvailable: false, updateAvailable: false, applying: false, message: 'App storage is unavailable. You can continue using Tavern online.' };
  w.statusListeners = new Set(); w.clicks = 0;
  createRoot(document.getElementById('root')!).render(<><PwaStatus/><main className='tavern-root' style={{ display: 'flex', flexDirection: 'column' }}><h1>Conversation</h1><div style={{ flex: 1 }}/><div className='composer' style={{ minHeight: 100, margin: 16 }}><button aria-label='Send message' className='send-button' style={{ marginLeft: 'auto', alignSelf: 'end' }} onClick={() => { w.clicks++; }}>Send</button></div></main></>);
}
