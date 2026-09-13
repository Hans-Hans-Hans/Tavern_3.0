import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServerRoleName } from '../../../app/role-identity';
import { MemberDirectory } from '../../../app/member-directory';
import { ActionMenu } from '../../../app/action-menu';
import { QuickProfile } from '../../../app/quick-profile';
import { defaultRolePolicy } from '../../../lib/roles';
import '../../../app/globals.css';
import '../../../app/community.css';

export function mountFixture() {
  const w = window as any, server = '!server:test', owner = '@owner:test', member = '@member:test';
  const f: any = { listeners: new Set(), membership: 'join', members: [
    { userId: owner, name: 'Owner', membership: 'join', powerLevel: 100, presence: 'offline' },
    { userId: member, name: 'Morgan', membership: 'join', powerLevel: 0, presence: 'online' },
    { userId: '@second:test', name: 'Elliot', membership: 'join', powerLevel: 0, presence: 'online' },
    { userId: '@third:test', name: 'River', membership: 'join', powerLevel: 0, presence: 'offline' },
  ] };
  f.policy = defaultRolePolicy(owner);
  f.policy.roles.push({ id: 'color', name: 'Designers', position: 30, color: '#b48cf2', icon: '', permissions: [], separate: false, mentionable: false },
    { id: 'group', name: 'Gardeners', position: 10, color: '#52b788', icon: '🌱', permissions: [], separate: true, mentionable: true });
  f.policy.members = { [member]: ['group','color'], '@third:test': ['group'] };
  f.notify = () => f.listeners.forEach((fn: () => void) => fn());
  const room = { roomId: server, name: 'Test server', isSpaceRoom: () => true, getMyMembership: () => f.membership,
    getMember: (user: string) => f.members.find((item: any) => item.userId === user),
    getJoinedMembers: () => f.members.filter((item: any) => item.membership === 'join'), getJoinedMemberCount: () => f.members.filter((item: any) => item.membership === 'join').length,
    currentState: { getStateEvents: () => ({ getContent: () => f.policy }), hasSufficientPowerLevelFor: () => true },
  };
  f.client = { getUserId: () => owner, getRoom: (id: string) => id === server ? room : undefined, getUser: (user: string) => f.members.find((item: any) => item.userId === user) };
  w.roleIdentityFixture = f;
  createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 700, margin: 'auto', padding: 12 }}>
    <section aria-label='Chat name'><ActionMenu actions={[{label:'Assign roles',run:()=>{f.assignmentOpened=true;}}]}><span className='message-author-trigger'><QuickProfile roomId={server} serverId={server} userId={member} onOpenFull={()=>{}}><button className='message-author'><ServerRoleName serverId={server} userId={member}>Morgan</ServerRoleName></button></QuickProfile></span></ActionMenu></section>
    <section aria-label='Direct-message name'><ServerRoleName userId={member}>Morgan</ServerRoleName></section>
    <MemberDirectory roomId={server} serverId={server} onProfile={() => {}} onMessage={() => {}}/>
  </main>);
}
