import React from 'react';
import { createRoot } from 'react-dom/client';
import * as icons from 'lucide-react';
import { ServerRoles } from '../../../app/server-roles';
import { privateFixture } from '../../fixtures/private-thread.mjs';
import '../../../app/globals.css';

export async function mountFixture() {
  const f = privateFixture(), w = window as any;
  f.actor = f.owner; f.account = {}; f.errors = []; f.drafts = new Map(); f.pendingFiles = new Map(); f.React = React; f.icons = icons;
  f.messages.set(f.sourceId, []);
  for (const room of f.client.getRooms()) room.getJoinedMemberCount = () => room.getJoinedMembers().length;
  f.policy.roles[1].name = 'Helpers'; f.policy.roles[1].mentionable = false; f.policy.members[f.member] = ['mod'];
  f.policy.roles.push({ id: 'other', name: 'Helpers', position: 60, permissions: [], mentionable: false });
  f.policy.members[f.other] = ['other'];
  f.client.getStateEvent = async (id: string, type: string, key = '') => structuredClone(f.states.get(id).find((event: any) => event.type === type && event.state_key === key)?.content);
  w.roleFixture = f;
  const boundaryPath = '/role-composer-boundary.js';
  const { Composer } = await import(/* @vite-ignore */ boundaryPath);
  createRoot(document.getElementById('root')!).render(<><ServerRoles serverId={f.serverId} enabled onChanged={async () => { f.notify(); }}/><Composer conversation={f.sourceId} name='Role test' members={f.client.getRoom(f.sourceId).getJoinedMembers().map((member: any) => ({ id: member.userId, name: member.name, role: 'member' }))} onSent={async () => {}}/></>);
}
