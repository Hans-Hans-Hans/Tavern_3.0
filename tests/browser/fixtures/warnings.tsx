import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServerWarnings, MyWarnings } from '../../../app/warnings';
import { setAccountDevice, setManagedAccount } from '../../../lib/api';
import '../../../app/globals.css';
export function mountFixture() {
  const w = window as any; w.authorized = !location.search.includes('unauthorized');
  setAccountDevice('MODERATOR-DEVICE'); setManagedAccount(true);
  const room = { roomId: '!room:local', name: 'Community lounge', getMyMembership: () => 'join', getMember: (id: string) => ({ membership: 'join', powerLevel: id === '@mod:local' ? 50 : 0 }), currentState: { getStateEvents: (type: string) => type === 'm.space.parent' ? [] : null, hasSufficientPowerLevelFor: () => w.authorized, maySendEvent: () => w.authorized } };
  w.fixtureClient = { getRoom: () => room, getUserId: () => '@mod:local' };
  createRoot(document.getElementById('root')!).render(location.search.includes('inbox') ? <MyWarnings/> : <ServerWarnings roomId='!room:local' userId='@member:local'/>);
}
