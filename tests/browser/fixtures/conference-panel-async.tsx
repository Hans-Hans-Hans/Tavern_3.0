import React from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { mountFixture as mountPanel } from './conference-audio-panel';
import { setAccountDevice } from '../../../lib/api';

export function mountFixture() {
  mountPanel();
  const f = (window as any).audioPanelFixture;
  f.deviceRequests = [];
  f.invalidate = (kind: string) => {
    if (kind === 'account') { setAccountDevice('D2'); setAccountDevice('D1'); }
    if (kind === 'actor') f.client.getUserId = () => '@replacement:local';
    if (kind === 'device') f.client.getDeviceId = () => 'D2';
    if (kind === 'room') {
      const old = f.rooms.get('!channel:local');
      f.rooms.set('!channel:local', Object.assign(Object.create(Object.getPrototypeOf(old)), old));
    }
  };
  const toasts = document.createElement('div'); document.body.append(toasts);
  createRoot(toasts).render(<Toaster/>);
}
