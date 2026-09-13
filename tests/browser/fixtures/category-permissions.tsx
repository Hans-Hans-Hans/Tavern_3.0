import React from 'react';
import { createRoot } from 'react-dom/client';
import { CategoryPermissions } from '../../../app/category-permissions';
export function mountFixture() {
  const w = window as any;
  w.policy = { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages', 'add_reactions', 'invite'], icon: '', color: '', separate: false, mentionable: false }], members: {}, overrides: {}, categoryOverrides: {} };
  w.layout = { categories: [{ id: 'chat', name: 'Chat' }, { id: 'other', name: 'Other' }], channels: [{ id: '!channel:local', category: 'chat' }] };
  const room = { roomId: '!server:local', isSpaceRoom: () => true, getMyMembership: () => 'join', getJoinedMembers: () => [{ userId: '@owner:local', name: 'Owner' }, { userId: '@bob:local', name: 'Bob' }], currentState: { maySendStateEvent: () => true, getStateEvents: (type: string) => type === 'm.space.child' ? [{ getContent: () => ({ via: ['local'] }), getStateKey: () => '!channel:local' }] : { getContent: () => type === 'io.tavern.roles' ? w.policy : w.layout } } };
  w.fixtureClient = { getUserId: () => '@owner:local', getRoom: () => room, getStateEvent: async (_room: string, type: string) => structuredClone(type === 'io.tavern.roles' ? w.policy : w.layout), roomState: async () => [{ type: 'io.tavern.roles', state_key: '', event_id: '$roles-' + (w.saves || 0), content: structuredClone(w.policy) }], sendStateEvent: async (_room: string, _type: string, value: unknown) => { w.policy = structuredClone(value); w.saves = (w.saves || 0) + 1; } };
  createRoot(document.getElementById('root')!).render(<CategoryPermissions serverId="!server:local" initialCategoryId="chat" />);
}
