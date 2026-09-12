import React from 'react';
import { createRoot } from 'react-dom/client';
import { MatrixEvent } from 'matrix-js-sdk';
import { Workspace } from '../../../app/tavern';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { SidebarProvider } from '../../../components/ui/sidebar';
import { fixtureSetDmClient } from '../../../lib/matrix';
import { dmRequestsFixture } from '../../fixtures/dm-requests.mjs';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any, f = dmRequestsFixture(); w.dmFixture = f; w.workspaceCalls = []; fixtureSetDmClient(f.client);
  f.add('!lobby:local', { name: 'Lobby', membership: 'join', direct: false });
  const servers: { id: string; name: string; roomIds: string[] }[] = [];
  if (new URLSearchParams(location.search).has('management')) {
    const parent = f.add('!games:local', { name: 'Games server', type: 'm.space', membership: 'join', direct: false });
    const voice = f.add('!voice:local', { name: 'Gaming Voice', membership: 'join', direct: false });
    let revision = 0;
    const state = (room: any, type: string, content: object, state_key = '') => room.currentState.setStateEvents([new MatrixEvent({
      event_id: '$fixture-' + ++revision, room_id: room.roomId, type, state_key, sender: f.actor, content,
    })]);
    for (const room of [parent, voice, f.client.getRoom('!lobby:local')]) {
      state(room, 'm.room.create', { creator: f.actor, room_version: '10', 'm.federate': false, ...(room === parent ? { type: 'm.space' } : {}) });
      state(room, 'm.room.power_levels', { users: { [f.actor]: 100 }, users_default: 0, state_default: 50 });
      if (room !== parent) { state(parent, 'm.space.child', { via: ['local'] }, room.roomId); state(room, 'm.space.parent', { via: ['local'], canonical: true }, parent.roomId); }
    }
    state(voice, 'io.tavern.channel', { kind: 'voice' });
    state(parent, 'io.tavern.roles', { version: 1, owner: f.actor,
      roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages', 'join_calls'] }, { id: 'gaming', name: 'Gaming', position: 1, permissions: [] }], members: {}, overrides: {} });
    servers.push({ id: parent.roomId, name: parent.name, roomIds: ['!lobby:local', voice.roomId] });
    const request = f.client.http.authedRequest.bind(f.client.http);
    f.client.http.authedRequest = async (method: any, path: string, query: any, body: any) => {
      const match = /^\/rooms\/([^/]+)\/state(?:\/([^/]+)(?:\/(.*))?)?$/.exec(path);
      if (['GET', 'PUT'].includes(method) && match) {
        const room = f.client.getRoom(decodeURIComponent(match[1])); if (!room) throw new Error('Unknown fixture room');
        if (method === 'PUT') {
          if (!match[2]) throw new Error('Fixture state writes require an event type');
          f.calls.push({ method, path, body }); state(room, decodeURIComponent(match[2]), body, decodeURIComponent(match[3] || '')); f.emit();
          return { event_id: room.currentState.getStateEvents(decodeURIComponent(match[2]), decodeURIComponent(match[3] || ''))!.getId() };
        }
        if (!match[2]) return [...room.currentState.events.values()].flatMap((events: any) => [...events.values()].map((event: any) => event.event));
        const event = room.currentState.getStateEvents(decodeURIComponent(match[2]), decodeURIComponent(match[3] || ''));
        if (!event) throw Object.assign(new Error('State not found'), { errcode: 'M_NOT_FOUND' });
        return event.getContent();
      }
      return request(method, path, query, body);
    };
  }
  f.accountData('io.tavern.onboarding', { completed: true }); f.accountData('io.tavern.appearance', { mode: 'light' });
  const bootstrap = () => ({ me: { id: f.actor, name: 'Bob', role: 'member' }, workspace: { name: 'Tavern' }, members: [{ id: f.actor, name: 'Bob', role: 'member' }, { id: '@alice:local', name: 'Alice', role: 'member' }], memberships: f.client.getRooms().filter(room => room.getMyMembership() === 'join').flatMap(room => room.getJoinedMembers().map(member => ({ conversation_id: room.roomId, user_id: member.userId }))), preferences: {}, preview: false, servers,
    conversations: f.client.getRooms().filter(room => room.getMyMembership() === 'join' && !room.isSpaceRoom()).map(room => ({ id: room.roomId, name: room.name, kind: Object.values(f.mapping).some((ids: any) => ids.includes(room.roomId)) ? 'dm' : 'channel', encrypted: true, unread: 0 })),
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
