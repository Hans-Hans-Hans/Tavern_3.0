import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemberRoleEditor } from '../../../app/member-roles';
import '../../../app/globals.css';
export function mountFixture() {
  const w = window as any;
  w.policy = { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: [] }, { id: 'mod', name: 'Moderator', position: 50, permissions: ['manage_roles'] }, { id: 'tag', name: 'Tag', position: 10, permissions: [] }, { id: 'other', name: 'Other', position: 20, permissions: [] }, { id: 'danger', name: 'Privileged', position: 30, permissions: ['manage_server'] }], members: { '@mod:local': ['mod'], '@target:local': [] }, overrides: {}, categoryOverrides: {} };
  w.powers = { users: { '@owner:local': 100, '@mod:local': 50 }, users_default: 0 };
  const targetPower = new URLSearchParams(location.search).get('targetPower'); if (targetPower) w.powers.users['@target:local'] = Number(targetPower);
  const room = { isSpaceRoom: () => true, getMyMembership: () => 'join', getMember: () => ({ membership: 'join' }), currentState: { maySendStateEvent: () => true, getStateEvents: (type: string) => type === 'm.room.create' ? { getSender: () => '@owner:local', getContent: () => ({ type: 'm.space', room_version: '11' }) } : { getId: () => '$observed-policy', getContent: () => type === 'm.room.power_levels' ? w.powers : w.policy } } };
  w.fixtureClient = { getUserId: () => '@mod:local', getRoom: () => room, getStateEvent: async (_room: string, type: string) => { if (type === 'm.room.power_levels' && w.promoteTargetDuringCheck) return { ...w.powers, users: { ...w.powers.users, '@target:local': 100 } }; return type === 'm.room.member' ? { membership: 'join' } : structuredClone(type === 'm.room.power_levels' ? w.powers : w.policy); }, sendStateEvent: async (_room: string, _type: string, value: any) => { w.policy = value; w.saves = (w.saves || 0) + 1; } };
  createRoot(document.getElementById('root')!).render(<MemberRoleEditor serverId='!server:local' userId='@target:local'/>);
}
