import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { ServerRoles } from '../../../app/server-roles';
import { MemberRolesDialog, openMemberRoles } from '../../../app/member-roles';
import { CategoryPermissions } from '../../../app/category-permissions';
import { defaultRolePolicy, rolePermissions } from '../../../lib/roles';
import { migratePublicationPolicy } from '../../../lib/conference-publication';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any, params = new URLSearchParams(location.search);
  const server = '!server:test', channel = '!voice:test', owner = '@owner:test', mod = '@mod:test', target = '@member:test';
  const f: any = { account: 0, actor: params.get('actor') === 'mod' ? mod : owner, device: 'ROLE_DEVICE', listeners: new Set(), writes: [], changed: 0, membership: 'join', holdRead: false, holdWrite: false, revision: 0, channel, parentLink: true, childLink: true, nativeChannelMembership: 'join' };
  f.policy = defaultRolePolicy(owner);
  f.policy.roles.push({ id: 'mod', name: 'Moderator', color: '#6699ff', icon: '🛡️', position: 50, permissions: ['manage_roles', 'manage_channels', 'pin_messages'], mentionable: false, separate: true });
  f.policy.roles.push({ id: 'helper', name: 'Helper', color: '#52b788', icon: '🌱', position: 10, permissions: ['pin_messages'], mentionable: false, separate: false });
  f.policy.members = { [mod]: ['mod'], [target]: ['helper'] };
  f.policy.categoryOverrides.chat = { roles: {}, users: {} };
  if (params.has('marked')) f.policy = migratePublicationPolicy(f.policy);
  f.powers = { users: { [owner]: 100, [mod]: 50, '@peer:test': 50 }, users_default: 0 };
  f.layout = { categories: [{ id: 'chat', name: 'Chat', icon: '' }], channels: [{ id: channel, category: 'chat' }] };
  f.members = [{ userId: owner, name: 'Owner' }, { userId: mod, name: 'Moderator' }, { userId: target, name: 'Morgan' }, { userId: '@peer:test', name: 'Native peer' }].map(member => ({ ...member, membership: 'join' }));
  f.notify = () => f.listeners.forEach((fn: () => void) => fn());
  const room = { roomId: server, name: 'Test server', isSpaceRoom: () => true, getMyMembership: () => f.membership, getJoinedMembers: () => f.members,
    getMember: (user: string) => f.members.find((item: any) => item.userId === user), currentState: {
      maySendStateEvent: () => true, getStateEvents: (kind: string, key?: string) => {
        if (kind === 'm.space.child') { const event = { getStateKey: () => key || channel, getContent: () => f.childLink ? ({ via: ['test'] }) : ({}) }; return key === undefined ? [event] : event; }
        return { getSender: () => owner, getId: () => '$roles-' + f.revision, getContent: () => kind === 'm.room.create' ? { type: 'm.space', room_version: '11', 'm.federate': false }
          : kind === 'm.room.power_levels' ? f.powers : kind === 'io.tavern.roles' ? f.policy : f.layout };
      },
    } };
  const waitRead = async () => { if (f.holdRead) await new Promise<void>(resolve => { f.releaseRead = () => { f.holdRead = false; resolve(); }; }); };
  const channels = new Map([channel, '!second:test'].map(id => [id, { roomId: id, name: id === channel ? 'Voice lounge' : 'Second voice', getMyMembership: () => 'join', isSpaceRoom: () => false,
    currentState: { getStateEvents: (type: string, key: string) => type === 'm.space.parent' && key === server ? { getContent: () => f.parentLink ? { canonical: true, via: ['test'] } : {} } : null } }]));
  f.client = { getUserId: () => f.actor, getDeviceId: () => f.device,
    getRoom: (id: string) => id === server ? room : channels.get(id),
    getStateEvent: async (_room: string, kind: string) => { const value = structuredClone(kind === 'io.tavern.roles' ? f.policy : kind === 'm.room.member' ? { membership: 'join' } : kind === 'm.room.power_levels' ? f.powers : f.layout); await waitRead(); return value; },
    roomState: async (id: string) => {
      const event = (type: string, content: unknown, state_key = '') => ({ type, state_key, content, event_id: '$fixture-' + type, sender: owner });
      const value = id === server ? [event('m.room.create', { type: 'm.space', 'm.federate': false }), event('m.room.member', { membership: f.membership }, f.actor),
        ...[channel, '!second:test'].map(id => event('m.space.child', f.childLink ? { via: ['test'] } : {}, id)), { type: 'io.tavern.roles', state_key: '', event_id: '$roles-' + f.revision, content: structuredClone(f.policy) }]
        : [event('m.room.create', { 'm.federate': false }), event('m.room.member', { membership: f.nativeChannelMembership }, f.actor), event('m.space.parent', f.parentLink ? { canonical: true, via: ['test'] } : {}, server)];
      await waitRead(); return value;
    },
    sendStateEvent: async (id: string, type: string, value: unknown, key: string) => {
      f.writes.push({ id, type, key, value: structuredClone(value) }); f.policy = structuredClone(value); f.revision++; f.notify();
      if (f.holdWrite) await new Promise<void>(resolve => { f.releaseWrite = () => { f.holdWrite = false; resolve(); }; });
      return { event_id: '$roles-' + f.revision };
    },
  };
  w.roleEditorFixture = f;
  const mode = params.get('mode');
  function App() {
    const [, redraw] = useState(0); f.redraw = () => redraw(value => value + 1);
    return <main style={{ padding: 12, maxWidth: 1040, margin: '0 auto' }}><Toaster/>{mode === 'member'
    ? <><button onClick={() => openMemberRoles(server, target)}>Edit Morgan</button><MemberRolesDialog onChanged={async () => { f.changed++; }}/></>
    : mode === 'category' ? <CategoryPermissions serverId={server} initialCategoryId="chat"/>
    : <ServerRoles serverId={server} channelId={mode === 'channel' ? f.channel : undefined} enabled onChanged={async () => { f.changed++; }}/>}</main>;
  }
  createRoot(document.getElementById('root')!).render(<App/>);
}
