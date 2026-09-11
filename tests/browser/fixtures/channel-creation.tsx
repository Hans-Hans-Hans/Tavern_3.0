import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelCreationForm } from '../../../app/channel-creation';
import '../../../app/globals.css';
export function mountFixture() {
  const w = window as any; w.actor = '@owner:local'; w.accountOwner = {}; w.listeners = []; w.created = []; w.writes = []; w.opened = [];
  w.layout = { version: 1, categories: [{ id: 'projects', name: 'Projects', icon: '📁' }], channels: [] };
  const ev = (type: string, content: any, key = '', sender = w.actor) => ({ type, content, state_key: key, sender, event_id: '$'+type+key });
  const parent = (name: string) => [ev('m.room.create', { room_version: '12', type: 'm.space', 'm.federate': false }), ev('m.room.name', { name }),
    ev('m.room.power_levels', { state_default: 50, users: {}, events: {} }), ev('m.room.member', { membership: 'join' }, w.actor),
    ev('m.room.member', { membership: 'join' }, '@peer:local'), ev('io.tavern.server.layout', structuredClone(w.layout))];
  const states: any = { '!server:local': parent('Design team'), '!other:local': parent('Other team') }; w.states = states;
  w.client = { getUserId: () => w.actor, getDeviceId: () => 'DEVICE', getHomeserverUrl: () => 'https://local/api/matrix',
    getRoom: (id: string) => ({ roomId: id, name: states[id]?.find((e: any) => e.type === 'm.room.name')?.content.name || id,
      getMyMembership: () => states[id]?.find((e: any) => e.type === 'm.room.member' && e.state_key === w.actor)?.content.membership,
      getMember: (user: string) => { const event = states[id]?.find((e: any) => e.type === 'm.room.member' && e.state_key === user); return event ? { membership: event.content.membership } : null; },
      currentState: { getStateEvents: (type: string, key?: string) => { const values = (states[id] || []).filter((e: any) => e.type === type).map((e: any) => ({ getContent: () => e.content, getStateKey: () => e.state_key, getSender: () => e.sender })); return key === undefined ? values : values.find((e: any) => e.getStateKey() === key) || null; } } }),
    roomState: async (id: string) => { if (w.beforeRead) await w.beforeRead(id); return structuredClone(states[id]); },
    createRoom: async (config: any) => {
      w.created.push(structuredClone(config)); const actor = w.actor;
      if (w.holdCreate) await new Promise<void>(resolve => { w.resolveCreate = resolve; });
      const id = '!created-' + w.created.length + ':local';
      states[id] = [ev('m.room.create', { ...config.creation_content, room_version: '12' }, '', actor), ev('m.room.name', { name: config.name }),
        ev('m.room.member', { membership: 'join' }, actor, actor), ev('m.room.power_levels', { users: {}, events: config.power_level_content_override.events }), ...config.initial_state.map((e: any) => ({ ...structuredClone(e), sender: actor }))];
      return { room_id: id };
    },
    joinRoom: async (id: string) => { w.writes.push(['join', id]); },
    sendStateEvent: async (id: string, type: string, content: any, key: string) => {
      if (w.failLayout && type === 'io.tavern.server.layout') { w.failLayout = false; throw new Error('Category save temporarily unavailable.'); }
      w.writes.push([type, id, structuredClone(content), key]); states[id] = states[id].filter((e: any) => e.type !== type || e.state_key !== key); states[id].push(ev(type, structuredClone(content), key));
    },
    invite: async (id: string, target: string) => { w.writes.push(['invite', id, target]); states[id].push(ev('m.room.member', { membership: 'invite' }, target)); },
  };
  const root = createRoot(document.getElementById('root')!);
  w.render = (serverId = '!server:local') => {
    const form = <div style={{ maxWidth: 600, margin: 'auto', padding: 12 }}><ChannelCreationForm serverId={serverId} policyEnabled={w.policyEnabled !== false} callsEnabled={w.callsEnabled !== false} members={[{ id: '@owner:local', name: 'Owner' }, { id: '@peer:local', name: 'Peer' }]} onCreated={async (id, isCurrent) => {
      w.openCurrent = isCurrent;
      if (w.holdOpen) await new Promise<void>(resolve => { w.resolveOpen = resolve; });
      if (isCurrent()) w.opened.push(id);
      w.openFinished = true;
    }}/></div>;
    root.render(new URLSearchParams(location.search).has('strict') ? <React.StrictMode>{form}</React.StrictMode> : form);
  };
  w.render();
}
