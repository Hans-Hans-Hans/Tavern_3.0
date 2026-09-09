import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ServerNicknameEditor } from '../../../app/server-nickname';
import { readMemberProfile } from '../../../lib/community';
import '../../../app/globals.css';
export function mountFixture() {
  const w = window as any;
  const event = (type: string, state_key: string, content: any, event_id = '$' + type + state_key) => ({ type, state_key, content, event_id, sender: '@owner:test' });
  w.state = [event('m.room.create', '', { type: 'm.space', 'm.federate': false }), event('m.room.power_levels', '', { users: { '@owner:test': 100, '@mod:test': 50 }, users_default: 0 }),
    event('io.tavern.roles', '', { version: 1, owner: '@owner:test', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: [] }, { id: 'mod', name: 'Moderator', position: 50, permissions: ['manage_nicknames'] }], members: { '@mod:test': ['mod'] }, overrides: {}, categoryOverrides: {} }),
    event('m.room.member', '@mod:test', { membership: 'join', displayname: 'Moderator' }), event('m.room.member', '@target:test', { membership: 'join', displayname: 'Member chosen name', 'io.tavern.profile': { bio: 'Original member bio', serverOverride: '!server:test' } })];
  w.writes = []; w.listeners = new Set<() => void>(); w.notify = () => w.listeners.forEach((listener: () => void) => listener());
  const wrap = (raw: any) => raw && ({ getContent: () => raw.content, getId: () => raw.event_id, getSender: () => raw.sender, getStateKey: () => raw.state_key });
  const room = { roomId: '!server:test', name: 'Test server', isSpaceRoom: () => true, getMyMembership: () => 'join', getMember: (user: string) => ({ name: w.state.find((e: any) => e.type === 'm.room.member' && e.state_key === user)?.content.displayname }),
    currentState: { getStateEvents: (type: string, key?: string) => key === undefined
      ? w.state.filter((e: any) => e.type === type).map(wrap)
      : wrap(w.state.find((e: any) => e.type === type && e.state_key === key)) } };
  w.fixtureClient = { getUserId: () => '@mod:test', getRoom: () => room, roomState: async () => { const result = structuredClone(w.state); if (w.promote) result.find((e: any) => e.type === 'm.room.power_levels').content.users['@target:test'] = 50; return result; },
    sendStateEvent: async (id: string, type: string, content: any, key: string) => { w.writes.push({ id, type, content, key }); w.state = w.state.filter((e: any) => e.type !== type || e.state_key !== key); const result = event(type, key, content, '$saved' + w.writes.length); w.state.push(result); w.notify(); return { event_id: result.event_id }; } };
  w.concurrentNickname = () => { w.state.push(event('io.tavern.server.nickname', '@target:test', { version: 1, name: 'Other moderator nickname' }, '$other')); w.notify(); };
  function Preview() { const [, update] = useState(0); useEffect(() => { const refresh = () => update(value => value + 1); w.listeners.add(refresh); return () => { w.listeners.delete(refresh); }; }, []); const profile = readMemberProfile('!server:test', '@target:test', '!server:test'); return <aside><output data-testid='visible-name'>{profile.name}</output><p>{profile.bio}</p><small>@target:test</small></aside>; }
  createRoot(document.getElementById('root')!).render(<><Preview/><ServerNicknameEditor serverId='!server:test' userId='@target:test'/></>);
}
