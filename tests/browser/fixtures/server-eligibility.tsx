import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServerEligibilitySettings } from '../../../app/server-eligibility';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any; w.writes = []; w.listeners = new Set();
  w.actor = new URLSearchParams(location.search).has('restricted') ? '@member:local' : '@owner:local';
  const values: any[] = [];
  const server: any = { roomId: '!server:local', name: 'Server', isSpaceRoom: () => true, getMyMembership: () => 'join',
    currentState: { getStateEvents: (type: string, key?: string) => key === undefined ? values.filter(event => event.type === type) : values.find(event => event.type === type && event.state_key === key) || null } };
  server.put = (type: string, content: any, key = '') => {
    const index = values.findIndex(event => event.type === type && event.state_key === key);
    const event = { type, content, state_key: key, event_id: '$state-' + w.writes.length + '-' + type, sender: '@owner:local', getContent: () => event.content, getStateKey: () => key, getSender: () => '@owner:local' };
    if (index < 0) values.push(event); else values.splice(index, 1, event);
    return content;
  };
  w.server = server;
  server.put('m.room.create', { type: 'm.space', room_version: '11', 'm.federate': false });
  server.power = server.put('m.room.power_levels', { users: { '@owner:local': 100, '@member:local': 100 }, events: {} });
  server.put('m.room.member', { membership: 'join' }, w.actor);
  server.put('io.tavern.roles', { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages'] }], members: {}, overrides: {}, categoryOverrides: {} });
  w.fixtureClient = {
    getUserId: () => w.actor, getRoom: (id: string) => id === server.roomId ? server : null,
    roomState: async () => { await w.beforeRead?.(); return values.map(({ type, content, state_key, event_id, sender }) => ({ type, content: structuredClone(content), state_key, event_id, sender })); },
    sendStateEvent: async (...args: any[]) => { await w.beforeWrite?.(); if (w.rejectWrite) throw new Error('The server rejected these settings.'); w.writes.push(args); server.put(args[1], args[2], args[3]); for (const listener of w.listeners) listener(); },
  };
  createRoot(document.getElementById('root')!).render(<ServerEligibilitySettings serverId={server.roomId}/>);
}
