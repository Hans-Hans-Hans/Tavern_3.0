import React from 'react';
import { createRoot } from 'react-dom/client';
import { SocialPanel } from '../../../app/social-panel';
import { setAccountDevice } from '../../../lib/api';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any, listeners = new Set<() => void>();
  w.socialOwner = { device: 'A', listeners, client: { getUserId: () => '@owner:local', getUser: (id: string) => ({ displayName: id === '@old-contact:local' ? 'Old contact' : 'New contact', presence: 'online' }), getIgnoredUsers: () => [], getRooms: () => [] }, messages: [] };
  w.socialOwner.switchDevice = (device: string, notify = true) => { setAccountDevice(device); w.socialOwner.device = device; if (notify) for (const listener of listeners) listener(); };
  setAccountDevice('A');
  createRoot(document.getElementById('root')!).render(<SocialPanel onMessage={id => w.socialOwner.messages.push(id)}/>);
}
