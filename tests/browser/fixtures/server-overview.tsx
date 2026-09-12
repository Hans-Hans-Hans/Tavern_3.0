import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ServerOverview } from '../../../app/server-overview';
import { ManagementSections } from '../../../app/management-sections';
import { setAccountDevice } from '../../../lib/api';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any, listeners = new Set<() => void>();
  const policy = { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Everyone', position: 0, permissions: [] }], members: {} };
  const state: Record<string, any> = { 'io.tavern.roles': policy };
  const event = (type: string, key = '') => ({ getContent: () => state[type] || {}, getStateKey: () => key, getSender: () => '@owner:local' });
  const room = { roomId: '!server:local', name: 'Our community', getMyMembership: () => 'join', isSpaceRoom: () => true,
    getMembers: () => [{ userId: '@owner:local', membership: 'join' }],
    currentState: { maySendStateEvent: () => true, getStateEvents: (type: string, key?: string) => key === undefined ? type === 'm.space.child' && state[type] ? [event(type, '!channel:local')] : [] : event(type, key) } };
  w.overviewFixture = { listeners, state, actions: [] as string[], client: { getUserId: () => '@owner:local', getRoom: () => room },
    sync: () => { for (const listener of listeners) listener(); },
    switchAccount: () => { setAccountDevice('B'); },
  };
  setAccountDevice('A');
  function Editor({ name }: { name: string }) { const [draft, setDraft] = useState(''); return <label>{name} draft<input value={draft} onChange={e => setDraft(e.target.value)}/></label>; }
  createRoot(document.getElementById('root')!).render(<ManagementSections label='Server settings sections' sections={[
    { id: 'overview', title: 'Overview', content: <ServerOverview serverId='!server:local' onCreateChannel={() => w.overviewFixture.actions.push('create')} onInvite={() => w.overviewFixture.actions.push('invite')}/> },
    ...['organization', 'roles', 'welcome'].map(name => ({ id: name, title: name, content: <Editor name={name}/> })),
  ]}/>);
}
