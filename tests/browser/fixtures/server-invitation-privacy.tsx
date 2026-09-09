import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServerInvitationPrivacy } from '../../../app/server-invitation-privacy';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any;
  const rooms = [{ roomId: '!server:test', name: 'Community', isSpaceRoom: () => true, getMyMembership: () => 'join' },
    { roomId: '!other:test', name: 'Other community', isSpaceRoom: () => true, getMyMembership: () => 'join' },
    { roomId: '!channel:test', name: 'Channel', isSpaceRoom: () => false, getMyMembership: () => 'join' }];
  w.privacyFixture = { account: {}, client: { getUserId: () => '@alice:test', getRooms: () => rooms }, listeners: new Set() };
  w.replacePrivacyAccount = () => { const f = w.privacyFixture; f.account = {}; f.client = { getUserId: () => '@bob:test', getRooms: () => rooms }; f.listeners.forEach((changed: () => void) => changed()); };
  w.replacePrivacyActor = () => { const f = w.privacyFixture; f.client.getUserId = () => '@bob:test'; f.listeners.forEach((changed: () => void) => changed()); };
  createRoot(document.getElementById('root')!).render(<ServerInvitationPrivacy/>);
}
