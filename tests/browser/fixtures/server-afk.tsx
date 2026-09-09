import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServerAfkSettings } from '../../../app/server-afk';
import '../../../app/globals.css';
export function mountFixture() {
  const w = window as any; w.writes = []; w.listeners = new Set(); w.actor = new URLSearchParams(location.search).has('restricted') ? '@member:local' : '@owner:local';
  function makeRoom(roomId: string, name: string, space = false) {
    const values: any[] = [], room: any = { roomId, name, values, isSpaceRoom: () => space, getMyMembership: () => 'join', currentState: { getStateEvents: (type: string, key?: string) => key === undefined ? values.filter(event => event.type === type) : values.find(event => event.type === type && event.state_key === key) || null } };
    room.put = (type: string, content: any, key = '') => { const at = values.findIndex(event => event.type === type && event.state_key === key); const event = { type, content, state_key: key, event_id: '$' + type + ':' + w.writes.length, sender: '@owner:local', getContent: () => event.content, getStateKey: () => key, getSender: () => '@owner:local' }; if (at >= 0) values.splice(at, 1, event); else values.push(event); return content; };
    room.put('m.room.create', { room_version: '11', 'm.federate': false, ...(space ? { type: 'm.space' } : {}) });
    room.power = room.put('m.room.power_levels', { users: { '@owner:local': 100, '@member:local': 100 }, events: {} }); room.put('m.room.member', { membership: 'join' }, w.actor); return room;
  }
  const server = makeRoom('!server:local', 'Server', true), voice = makeRoom('!voice:local', 'Quiet room'), text = makeRoom('!text:local', 'Text channel'); w.server = server;
  server.put('io.tavern.roles', { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages'] }], members: {}, overrides: {}, categoryOverrides: {} });
  for (const room of [voice, text]) { server.put('m.space.child', { via: ['local'] }, room.roomId); room.put('m.space.parent', { canonical: true, via: ['local'] }, server.roomId); room.put('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }); room.put('io.tavern.channel', { version: 1, kind: room === voice ? 'voice' : 'text', archived: false }); }
  const rooms = [server, voice, text]; w.fixtureClient = { getUserId: () => w.actor, getRoom: (id: string) => rooms.find(room => room.roomId === id), getRooms: () => rooms, roomState: async (id: string) => { await w.beforeRead?.(); return rooms.find(room => room.roomId === id)!.values.map(({ type, state_key, event_id, content, sender }: any) => ({ type, state_key, event_id, content: structuredClone(content), sender })); }, sendStateEvent: async (id: string, type: string, content: any, key: string) => { w.writes.push([id, type, content, key]); rooms.find(room => room.roomId === id)!.put(type, content, key); for (const fn of w.listeners) fn(); } };
  createRoot(document.getElementById('root')!).render(<ServerAfkSettings serverId={server.roomId}/>);
}
