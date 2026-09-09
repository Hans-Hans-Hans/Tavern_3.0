import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServerOnboardingSettings, ServerWelcomeFlow } from '../../../app/server-onboarding';
import { ServerDialog } from '../../../app/server-dialog';
import { NotificationSettings } from '../../../app/notification-settings';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any, query = new URLSearchParams(location.search); w.writes = []; w.actions = []; w.listeners = []; w.accounts = {};
  w.actor = query.has('restricted') ? '@member:local' : '@owner:local';
  function makeRoom(roomId: string, name: string) {
    const values: any[] = [];
    const room: any = { roomId, name, values, isSpaceRoom: () => roomId === '!server:local', getMyMembership: () => roomId === '!rules:local' ? 'invite' : 'join', currentState: { getStateEvents: (type: string, key?: string) => key === undefined ? values.filter(event => event.type === type) : values.find(event => event.type === type && event.state_key === key) || null } };
    room.put = (type: string, content: any, key = '') => { const at = values.findIndex(event => event.type === type && event.state_key === key); const event = { type, content, state_key: key, event_id: '$' + type + ':' + w.writes.length, sender: '@owner:local', getContent: () => event.content, getStateKey: () => key, getSender: () => '@owner:local' }; if (at >= 0) values.splice(at, 1, event); else values.push(event); return content; };
    room.put('m.room.create', { room_version: '11', 'm.federate': false, ...(room.isSpaceRoom() ? { type: 'm.space' } : {}) });
    room.power = room.put('m.room.power_levels', { users: { '@owner:local': 100, '@member:local': 100 }, events: {} });
    room.put('m.room.member', { membership: 'join' }, w.actor);
    return room;
  }
  const server = makeRoom('!server:local', 'Gaming'), general = makeRoom('!general:local', 'General'), rules = makeRoom('!rules:local', 'Rules');
  w.server = server;
  server.put('io.tavern.roles', { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages'] }], members: {}, overrides: {}, categoryOverrides: {} });
  server.put('io.tavern.server.onboarding', { version: 1, enabled: true, startChannel: '', welcomeChannel: '', rulesChannel: query.has('welcome') ? rules.roomId : '', recommended: [], interests: [] });
  server.put('io.tavern.notification.defaults', { version: 1, mode: 'mentions' });
  for (const room of [general, rules]) { server.put('m.space.child', { via: ['local'] }, room.roomId); room.put('m.space.parent', { via: ['local'], canonical: true }, server.roomId); }
  const rooms: any = { [server.roomId]: server, [general.roomId]: general, [rules.roomId]: rules };
  w.fixtureClient = { getUserId: () => w.actor, getRoom: (id: string) => rooms[id], getAccountData: (key: string) => w.accounts[key] ? { getContent: () => w.accounts[key] } : null, getAccountDataFromServer: async (key: string) => w.accounts[key], setAccountData: async (key: string, content: any) => { w.accounts[key] = content; }, roomState: async (id: string) => { if (w.beforeRead) await w.beforeRead(); return rooms[id].values.map(({ type, state_key, event_id, content, sender }: any) => ({ type, state_key, event_id, content: structuredClone(content), sender })); }, sendStateEvent: async (id: string, type: string, content: any, key: string) => { w.writes.push([id, type, content, key]); rooms[id].put(type, content, key); w.listeners.forEach((fn: any) => fn()); } };
  createRoot(document.getElementById('root')!).render(query.has('create') ? <ServerDialog open naming='standard' onClose={() => { w.closed = true; }} onCreated={async id => { w.created = id; }}/> : query.has('welcome') ? <ServerWelcomeFlow serverId={server.roomId} forceOpen onSelect={id => { w.selected = id; }}/> : query.has('personal') ? <NotificationSettings/> : <ServerOnboardingSettings serverId={server.roomId}/>);
}
