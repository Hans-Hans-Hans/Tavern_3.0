import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Circle, Hash, Users } from 'lucide-react';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { canEditCommunity, serverChannelIds } from '@/lib/community';
import { readRolePolicy } from '@/lib/roles';
import { readServerOnboarding } from '@/lib/server-onboarding';
import { CommunityImage } from './community-settings';
import { useManagementNavigation } from './management-sections';
import './server-overview.css';

export function ServerOverview({ serverId, onCreateChannel, onInvite }: { serverId: string; onCreateChannel: () => void; onInvite?: () => void }) {
  const owner = useRef({ client: getMatrixClient(), actor: getMatrixClient()?.getUserId(), generation: accountArtworkOwner(), serverId }).current;
  const [, redraw] = useState(0), [hidden, setHidden] = useState(false), choose = useManagementNavigation();
  useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  const current = () => getMatrixClient() === owner.client && getMatrixClient()?.getUserId() === owner.actor && accountArtworkOwner() === owner.generation && serverId === owner.serverId;
  if (!current()) return <p role='status'>Your account changed. Reopen server settings.</p>;
  const room = owner.client?.getRoom(serverId), policy = readRolePolicy(serverId), channels = serverChannelIds(serverId), welcome = readServerOnboarding(serverId);
  if (!room || room.getMyMembership() !== 'join') return <p role='status'>Server settings are unavailable. Check your membership and connection.</p>;
  const avatarContent = room.currentState.getStateEvents('m.room.avatar', '')?.getContent()?.url;
  const topicContent = room.currentState.getStateEvents('m.room.topic', '')?.getContent()?.topic;
  const avatar = typeof avatarContent === 'string' ? avatarContent : '';
  const topic = typeof topicContent === 'string' ? topicContent : '';
  const members = room.getMembers().filter(member => member.membership === 'join' || member.membership === 'invite');
  const isOwner = policy?.owner === owner.actor;
  const steps = [
    { id: 'organization', title: 'Give it your identity', description: 'Add an icon and a description so people recognize your server.', done: !!avatar && !!topic, action: () => choose('organization') },
    { id: 'channels', title: 'Make room for conversation', description: 'Create a channel for messages, voice or a shared interest.', done: channels.length > 0, action: onCreateChannel },
    { id: 'welcome', title: 'Welcome new members', description: 'Choose the channels people should see first.', done: welcome.enabled && [welcome.startChannel, ...welcome.recommended].some(id => channels.includes(id)), action: () => choose('welcome') },
    { id: 'roles', title: 'Set up your team', description: 'Create roles and assign the permissions your community needs.', done: !!policy?.roles.some(role => role.id !== 'everyone'), action: () => choose('roles') },
    { id: 'invitations', title: 'Bring someone along', description: 'Invite a friend. They choose whether to join.', done: members.some(member => member.userId !== owner.actor), action: onInvite },
  ];
  return <section className='server-overview' aria-label='Server overview'>
    <div className='server-overview-identity'><CommunityImage mxc={avatar} name={room.name} size={64}/><div><h2>{room.name}</h2><p>{topic || 'A place for your people.'}</p></div></div>
    <div className='server-overview-facts'><span><Hash size={18}/>{channels.length} linked channels</span><span><Users size={18}/>{members.filter(member => member.membership === 'join').length} synced members</span></div>
    {isOwner && <><div className='server-setup-heading'><div><h3>Make yourself at home</h3><p>{steps.filter(step => step.done).length} of {steps.length} suggestions complete</p></div><button className='secondary-button' aria-expanded={!hidden} onClick={() => { if (current()) setHidden(value => !value); }}>{hidden ? 'Show setup guide' : 'Hide setup guide'}</button></div>
      {!hidden && <ol className='server-setup-checklist'>{steps.map(step => <li key={step.id} data-complete={step.done}><span className='server-setup-check' aria-label={step.done ? 'Complete' : 'Not complete'}>{step.done ? <Check size={18}/> : <Circle size={18}/>}</span><div><strong>{step.title}</strong><p>{step.description}</p></div>{step.action && <button type='button' className='icon-button' aria-label={step.title} onClick={() => { if (current() && readRolePolicy(serverId)?.owner === owner.actor && (step.id !== 'channels' || canEditCommunity(serverId, 'layout'))) step.action?.(); }}><ChevronRight size={20}/></button>}</li>)}</ol>}
      {!hidden && <p className='login-help'>These suggestions are optional. Progress reflects settings and members synced from your server; opening a step does not mark it complete.</p>}
    </>}
    <p className='login-help'>Server membership and channel access are managed separately. Use the settings sections to update your community.</p>
  </section>;
}
