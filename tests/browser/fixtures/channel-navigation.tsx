import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelNavigation } from '../../../app/channel-navigation';
import '../../../app/globals.css';
import '../../../app/community.css';

// The real component, layout reader/writer and permissions run against a bounded
// SDK boundary. No network, Matrix room, notification or media delivery is claimed.
export function mountFixture() {
  const w = window as any;
  const start = { version: 1, categories: [{ id: 'chat', name: 'Chat', icon: '' }, { id: 'games', name: 'Games', icon: '' }], channels: [{ id: '!root:local', category: '' }, { id: '!general:local', category: 'chat' }, { id: '!rules:local', category: 'chat' }, { id: '!voice:local', category: 'games' }, { id: '!forum:local', category: 'games' }] };
  const names: Record<string, string> = { '!root:local': 'Lobby', '!general:local': 'General', '!rules:local': 'Rules', '!voice:local': 'Lounge', '!forum:local': 'Topics' };
  w.layout = JSON.parse(localStorage.getItem('fixture-layout') || 'null') || start;
  w.revision = '$layout:0'; w.actor = '@owner:local'; w.account = 'A:1'; w.device = 'DEVICE'; w.allowed = true; w.saves = []; w.selected = []; w.callbacks = []; w.listeners = new Set(); w.prefs = {}; w.left = new Set(); w.rooms = new Map();
  w.emit = () => { for (const listener of [...w.listeners]) (listener as () => void)(); };
  const content = (id: string, type: string, key: string) => {
    if (type === 'm.room.create') return { type: id === '!server:local' ? 'm.space' : undefined, 'm.federate': false, room_version: '12' };
    if (type === 'm.room.power_levels') return { state_default: w.allowed ? 50 : 999, users: { '@owner:local': w.allowed ? 100 : 0, '@other:local': 100 } };
    if (type === 'm.room.member') return { membership: w.left.has(id) ? 'leave' : 'join' };
    if (type === 'io.tavern.server.layout' && id === '!server:local') return w.layout;
    if (type === 'io.tavern.channel') return { version: 1, kind: id === '!voice:local' ? 'voice' : id === '!rules:local' ? 'rules' : id === '!forum:local' ? 'forum' : 'text', archived: false };
    if (type === 'm.space.child' && id === '!server:local' && Object.hasOwn(names, key)) return { via: ['local'] };
    if (type === 'm.space.parent' && id !== '!server:local' && key === '!server:local') return { via: ['local'], canonical: true };
    return undefined;
  };
  const event = (id: string, type: string, key = '') => {
    const value = content(id, type, key); if (value === undefined) return null;
    return { getContent: () => value, getSender: () => '@owner:local', getId: () => w.revision, getStateKey: () => key, getType: () => type };
  };
  const state = (id: string) => ['m.room.create', 'm.room.power_levels', 'io.tavern.server.layout', 'io.tavern.channel'].map(type => ({ type, state_key: '', content: content(id, type, '') })).concat([{ type: 'm.room.member', state_key: w.actor, content: content(id, 'm.room.member', w.actor) }], Object.keys(names).map(key => ({ type: 'm.space.child', state_key: key, content: content(id, 'm.space.child', key) }))).filter(value => value.content !== undefined).map(value => ({ ...value, event_id: value.type === 'io.tavern.server.layout' ? w.revision : '$state:' + value.type + value.state_key, room_id: id, sender: '@owner:local' }));
  for (const id of ['!server:local', ...Object.keys(names)]) w.rooms.set(id, { roomId: id, name: names[id] || 'Server', getMyMembership: () => w.left.has(id) ? 'leave' : 'join', isSpaceRoom: () => id === '!server:local', canInvite: () => true, currentState: { maySendStateEvent: () => w.allowed, getStateEvents: (type: string, key?: string) => key !== undefined ? event(id, type, key) : type === 'm.space.child' && id === '!server:local' ? Object.keys(names).map(key => event(id, type, key)) : type === 'm.space.parent' && id !== '!server:local' ? [event(id, type, '!server:local')] : [event(id, type)].filter(Boolean) } });
  w.client = {
    getUserId: () => w.actor, getDeviceId: () => w.device, getHomeserverUrl: () => 'https://local', getRoom: (id: string) => w.rooms.get(id), getAccountData: (type: string) => ({ getContent: () => w.prefs[type] }),
    roomState: async (id: string) => { const result = structuredClone(state(id)); w.reads = (w.reads || 0) + 1; if (w.holdRead) await new Promise(resolve => { w.releaseRead = resolve; }); return result; },
    sendStateEvent: async (id: string, type: string, value: any) => {
      w.started = structuredClone(value);
      if (w.holdSave) await new Promise(resolve => { w.releaseSave = resolve; });
      if (w.failSave) throw new Error('Fixture server rejected this layout.');
      if (value['io.tavern.previous_event'] !== w.revision) throw new Error('The layout changed elsewhere.');
      const { 'io.tavern.previous_event': _, ...saved } = value;
      w.layout = saved; w.saves.push({ id, type, value }); w.revision = '$layout:' + w.saves.length;
      localStorage.setItem('fixture-layout', JSON.stringify(saved)); w.emit(); return { event_id: w.revision };
    },
    getAccountDataFromServer: async (type: string) => structuredClone(w.prefs[type] || {}),
    setAccountData: async (type: string, value: any) => { w.prefs[type] = value; w.emit(); },
  };
  function App() {
    const [, redraw] = useState(0); w.redraw = () => redraw(value => value + 1);
    const channels = Object.keys(names).map(id => ({ id, name: names[id], unread: id === '!general:local' ? 3 : id === '!rules:local' ? 100 : 0, mentions: id === '!general:local' ? 2 : 0 }));
    return <div className='channel-sidebar' style={{ width: 340, height: 450, overflowY: 'auto', padding: 10 }}><ChannelNavigation serverId={w.serverId || '!server:local'} channels={channels} active='!general:local' createCategoryRequest={w.categoryRequest || 0} muted={['!rules:local']} focus={!!w.focusMode} onSelect={id => w.selected.push(id)} onCreateChannel={value => w.callbacks.push(['create', value])} onEditChannel={id => w.callbacks.push(['edit', id])} onInviteChannel={id => w.callbacks.push(['invite', id])} renderParticipants={id => <div data-testid='voice-participants'>Live roster for {id}</div>}/></div>;
  }
  createRoot(document.getElementById('root')!).render(<App/>);
}
