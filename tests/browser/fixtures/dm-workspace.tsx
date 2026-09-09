import React from 'react';
import { createRoot } from 'react-dom/client';
import { Workspace } from '../../../app/tavern';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { SidebarProvider } from '../../../components/ui/sidebar';
import { fixtureSetDmClient } from '../../../lib/matrix';
import { dmRequestsFixture } from '../../fixtures/dm-requests.mjs';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any, f = dmRequestsFixture(); w.dmFixture = f; w.workspaceCalls = []; fixtureSetDmClient(f.client);
  f.add('!lobby:local', { name: 'Lobby', membership: 'join', direct: false });
  f.accountData('io.tavern.onboarding', { completed: true }); f.accountData('io.tavern.appearance', { mode: 'light' });
  const bootstrap = () => ({ me: { id: f.actor, name: 'Bob', role: 'member' }, workspace: { name: 'Tavern' }, members: [{ id: f.actor, name: 'Bob', role: 'member' }, { id: '@alice:local', name: 'Alice', role: 'member' }], memberships: f.client.getRooms().filter(room => room.getMyMembership() === 'join').flatMap(room => room.getJoinedMembers().map(member => ({ conversation_id: room.roomId, user_id: member.userId }))), preferences: {}, preview: false, servers: [],
    conversations: f.client.getRooms().filter(room => room.getMyMembership() === 'join').map(room => ({ id: room.roomId, name: room.name, kind: Object.values(f.mapping).some((ids: any) => ids.includes(room.roomId)) ? 'dm' : 'channel', encrypted: true, unread: 0 })),
    invitations: f.client.getRooms().filter(room => room.getMyMembership() === 'invite').map(room => ({ id: room.roomId, name: room.name })) });
  w.matrixBoundary = (name: string, args: any[]) => {
    if (name === 'matrixStatus') return { connected: true, state: 'Connected' };
    if (name === 'matrixTyping') return []; if (name === 'restoreMatrixSession') return Promise.resolve(true);
    if (name === 'matrixApi') {
      const [action, p, params] = args; w.workspaceCalls.push([action, p, params]);
      if (action === 'bootstrap') return Promise.resolve(bootstrap());
      if (action === 'messages' && params?.conversation === f.room.roomId && f.room.getMyMembership() !== 'join') throw new Error('Invitation messages must not be fetched before acceptance.');
      if (action === 'read') return Promise.resolve({ ok: true });
      return Promise.resolve({ messages: [], hasMore: false });
    }
    return Promise.resolve();
  };
  createRoot(document.getElementById('root')!).render(<TooltipProvider><SidebarProvider><Workspace/></SidebarProvider></TooltipProvider>);
}
