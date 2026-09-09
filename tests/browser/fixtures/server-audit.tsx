import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServerAudit } from '../../../app/server-audit';
import '../../../app/globals.css';
export function mountFixture() {
  const w = window as any; w.pages = [];
  const server = { roomId: '!server:local', name: 'Community', isSpaceRoom: () => true, getMyMembership: () => 'join', getMember: () => ({ powerLevel: 100 }), currentState: { getStateEvents: (type: string) => type === 'm.space.child' ? [] : null } };
  w.fixtureClient = { getUserId: () => '@owner:local', getRoom: () => server, createMessagesRequest: async (_room: string, from: string | null, limit: number, _direction: string, filter: any) => { w.pages.push({ from, limit, filter: filter.getDefinition() }); return { end: from ? null : 'opaque-older', chunk: [{ event_id: from ? '$older' : '$recent', sender: '@moderator:local', type: from ? 'm.room.member' : 'io.tavern.roles', state_key: from ? '@member:local' : '', origin_server_ts: from ? 1600000000000 : 1700000000000, content: from ? { membership: 'ban', reason: 'Repeated spam' } : { roles: [{ id: 'member', name: 'Member' }], members: {} } }] }; } };
  createRoot(document.getElementById('root')!).render(<ServerAudit serverId='!server:local'/>);
}
