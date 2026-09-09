import React from 'react';
import { createRoot } from 'react-dom/client';
import { TemporaryBans } from '../../../app/temporary-bans';
import { setManagedAccount } from '../../../lib/api';
import '../../../app/globals.css';
export function mountFixture() {
  const w = window as any;
  const room = { roomId: '!room:local', getMyMembership: () => 'join', getMember: (id: string) => ({ powerLevel: id === '@mod:local' ? 50 : 0 }),
    currentState: { getStateEvents: (_type: string, key?: string) => key === undefined ? [] : null, hasSufficientPowerLevelFor: () => true, maySendStateEvent: () => true } };
  w.fixtureClient = { getRoom: () => room, getUserId: () => '@mod:local' };
  setManagedAccount(true);
  createRoot(document.getElementById('root')!).render(<TemporaryBans roomId='!room:local' userId='@member:local'/>);
}
