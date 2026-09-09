import React from 'react';
import { createRoot } from 'react-dom/client';
import { BulkModeration } from '../../../app/bulk-moderation';
import '../../../app/globals.css';
export function mountFixture() {
  const w = window as any; w.redactions = [];
  const room = { roomId: '!room:local', getMyMembership: () => 'join', getMember: () => ({ powerLevel: 50 }), currentState: { getStateEvents: (type: string) => type === 'm.space.parent' ? [] : null, hasSufficientPowerLevelFor: () => true, maySendEvent: () => true } };
  w.fixtureClient = { getRoom: () => room, getUserId: () => '@mod:local', fetchRoomEvent: async (_room: string, id: string) => ({ event_id: id, type: 'm.room.encrypted', content: {} }), redactEvent: async (_room: string, id: string, _txn: string, options: any) => { if (id === '$bad') throw new Error('The homeserver could not confirm this redaction.'); w.redactions.push({ id, reason: options.reason }); } };
  createRoot(document.getElementById('root')!).render(<BulkModeration roomId='!room:local' messages={[{ id: '$good', author_id: '@member:local', body: 'Spam one' }, { id: '$bad', author_id: '@member:local', body: 'Spam two' }]} />);
}
