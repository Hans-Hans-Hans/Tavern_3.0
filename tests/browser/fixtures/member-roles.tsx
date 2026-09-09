import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemberRoleEditor } from '../../../app/member-roles';
import '../../../app/globals.css';
export function mountFixture() {
  const w = window as any;
  w.policy = { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: [] }, { id: 'mod', name: 'Moderator', position: 50, permissions: ['manage_roles'] }, { id: 'tag', name: 'Tag', position: 10, permissions: [] }, { id: 'other', name: 'Other', position: 20, permissions: [] }, { id: 'danger', name: 'Privileged', position: 30, permissions: ['manage_server'] }], members: { '@mod:local': ['mod'], '@target:local': [] }, overrides: {}, categoryOverrides: {} };
  const room = { isSpaceRoom: () => true, getMyMembership: () => 'join', getMember: () => ({ membership: 'join' }), currentState: { maySendStateEvent: () => true, getStateEvents: () => ({ getId: () => '$observed-policy', getContent: () => w.policy }) } };
  w.fixtureClient = { getUserId: () => '@mod:local', getRoom: () => room, getStateEvent: async (_room: string, type: string) => type === 'm.room.member' ? { membership: 'join' } : structuredClone(w.policy), sendStateEvent: async (_room: string, _type: string, value: any) => { w.policy = value; w.saves = (w.saves || 0) + 1; } };
  createRoot(document.getElementById('root')!).render(<MemberRoleEditor serverId='!server:local' userId='@target:local'/>);
}
