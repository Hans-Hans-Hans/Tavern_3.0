import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelAdmin } from '../../../app/channel-admin';
import { RoomPermissions } from '../../../app/room-permissions';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any; w.writes = []; w.listeners = [];
  w.actor = new URLSearchParams(location.search).has('owner') ? '@owner:local' : '@moderator:local';
  const makeRoom = (id: string) => {
    const values: any[] = [];
    const room: any = { roomId: id, name: 'Test conversation', values, currentState: { getStateEvents: (type: string, key?: string) => key === undefined ? values.filter(value => value.type === type) : values.find(value => value.type === type && value.state_key === key) || null }, getMyMembership: () => room.getMember(w.actor)?.membership };
    room.getMember = (user: string) => { const content = room.currentState.getStateEvents('m.room.member', user)?.getContent(); return content ? { userId: user, name: user, membership: content.membership } : null; };
    room.getMembers = () => values.filter(value => value.type === 'm.room.member').map(value => room.getMember(value.state_key));
    room.put = (type: string, content: any, key = '') => { const event = { type, state_key: key, content, sender: '@owner:local', getContent: () => event.content, getStateKey: () => key, getSender: () => '@owner:local' }; values.push(event); return content; };
    room.put('m.room.create', { room_version: '11', ...(id === '!server:local' ? { type: 'm.space' } : {}) });
    room.power = room.put('m.room.power_levels', { users: { '@owner:local': 100, '@moderator:local': 50 }, users_default: 0, events: {} });
    for (const user of ['@owner:local', '@moderator:local', '@member:local', '@peer:local']) room.put('m.room.member', { membership: 'join' }, user);
    return room;
  };
  const room = makeRoom('!room:local'), server = makeRoom('!server:local');
  w.roomPower = room.power;
  w.policy = server.put('io.tavern.roles', { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: [] }, { id: 'moderator', name: 'Moderator', position: 10, permissions: ['manage_channels', 'kick', 'ban'] }], members: { '@moderator:local': ['moderator'], '@peer:local': ['moderator'] }, overrides: {}, categoryOverrides: {} });
  room.put('m.space.parent', { via: ['local'], canonical: true }, server.roomId); server.put('m.space.child', { via: ['local'] }, room.roomId);
  const rooms: any = { [room.roomId]: room, [server.roomId]: server };
  w.fixtureClient = { getUserId: () => w.actor, getRoom: (id: string) => rooms[id], roomState: async (id: string) => { if (w.beforeRead) await w.beforeRead(); return rooms[id].values.map(({ type, state_key, content, sender }: any) => ({ type, state_key, content: structuredClone(content), sender })); }, sendStateEvent: async (...args: any[]) => { w.writes.push(args); }, kick: async (...args: any[]) => w.writes.push(['kick', ...args]), ban: async (...args: any[]) => w.writes.push(['ban', ...args]), unban: async (...args: any[]) => w.writes.push(['unban', ...args]) };
  createRoot(document.getElementById('root')!).render(<><ChannelAdmin roomId={room.roomId} onChanged={async () => {}}/><RoomPermissions roomId={room.roomId}/></>);
}
