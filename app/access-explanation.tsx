import { useState } from 'react';
import { Check, ShieldCheck, X } from 'lucide-react';
import { readServerLayout } from '@/lib/community';
import { memberServerRoles, nativeMemberPower, readRolePolicy, rolePermissions, type RolePermission } from '@/lib/roles';
import { explainRolePermission, explainRolesPermission } from '@/lib/role-access';
import { useRoleEditorOwner } from './role-editor-owner';

export function AccessExplanation({ serverId, channelId }: { serverId: string; channelId?: string }) {
  const owner = useRoleEditorOwner(serverId, channelId), client = owner.client, server = client?.getRoom(serverId), policy = readRolePolicy(serverId);
  const [member, setMember] = useState(owner.user), [channel, setChannel] = useState(channelId || ''), [query, setQuery] = useState('');
  const [permissionQuery, setPermissionQuery] = useState(''), [filter, setFilter] = useState('all');
  const [view, setView] = useState('member'), [previewRoles, setPreviewRoles] = useState<string[]>([]);
  if (!owner.current() || !server || !policy || !client) return null;
  const layout = readServerLayout(serverId), roomId = channelId || channel, room = client.getRoom(roomId), category = layout.channels.find(value => value.id === roomId)?.category;
  const selected = server.getMember(member), joined = room?.getMember(member)?.membership === 'join';
  const matching = server.getJoinedMembers().filter(value => (value.name + ' ' + value.userId).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const members = matching.slice(0, 100);
  if (selected?.membership === 'join' && !members.some(value => value.userId === member)) members.splice(99, 1, selected);
  let power: number | null = null;
  try { if (room) power = nativeMemberPower(room, member); } catch { /* Unknown remains explicit. */ }
  const missingRole = previewRoles.some(id => !policy.roles.some(role => role.id === id));
  const rows = (Object.entries(rolePermissions) as [RolePermission, string][]).map(([permission, label]) => ({ permission, label, steps: view === 'roles' ? explainRolesPermission(policy, missingRole ? [] : previewRoles, permission, roomId || undefined, category) : explainRolePermission(policy, member, permission, roomId || undefined, category) }))
    .filter(row => row.label.toLocaleLowerCase().includes(permissionQuery.trim().toLocaleLowerCase()) && (filter === 'all' || row.steps.at(-1)!.allowed === (filter === 'allowed')));
  const channelListed = !roomId || !!channelId || layout.channels.some(value => value.id === roomId);
  return <details className='access-explanation'><summary><ShieldCheck size={18}/>Explain a member’s access</summary>
    <p className='login-help'>Based on synced settings. Unsaved changes in this editor are not included.</p>
    <label>Inspect access for<select value={view} onChange={event => { setView(event.target.value); setQuery(''); }}><option value='member'>A member</option><option value='roles'>Preview roles</option></select></label>
    {view === 'member' ? <><div className='role-access-filters'><label>Find a member<input type='search' value={query} onChange={event => setQuery(event.target.value)}/></label><label>Member<select value={member} onChange={event => setMember(event.target.value)}>{members.map(value => <option key={value.userId} value={value.userId}>{value.name} ({value.userId})</option>)}</select></label></div>
    {matching.length > 100 && <p className='login-help'>Showing the first 100 matches and keeping the selected member available. Refine your search to find someone else.</p>}</> : <><label>Find a role to preview<input type='search' value={query} onChange={event => setQuery(event.target.value)}/></label><div className='role-preview-selection' role='group' aria-label='Roles to preview'>{[...policy.roles].sort((a,b) => b.position-a.position).filter(role => role.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(role => <label key={role.id}><input type='checkbox' checked={role.id === 'everyone' || previewRoles.includes(role.id)} disabled={role.id === 'everyone'} onChange={event => setPreviewRoles(ids => event.target.checked ? [...ids, role.id] : ids.filter(id => id !== role.id))}/>{role.icon} {role.name}{role.id === 'everyone' ? ' (everyone, automatic)' : ''}</label>)}</div><p className='login-help'>Preview one or several roles together. This does not change your account, memberships or permissions.</p></>}
    {!channelId && <label>Channel<select value={channel} onChange={event => setChannel(event.target.value)}><option value=''>Server roles only</option>{layout.channels.map(value => <option key={value.id} value={value.id}>{client.getRoom(value.id)?.name || value.id}</option>)}</select></label>}
    {view === 'member' && (!selected || selected.membership !== 'join') ? <p role='status'>That member is no longer joined to this server. Choose a current member.</p> : view === 'roles' && missingRole ? <p role='status'>A previewed role was removed. <button type='button' className='secondary-button' onClick={() => setPreviewRoles([])}>Reset role preview</button></p> : !channelListed ? <p role='status'>This channel is no longer listed here. Choose a current channel.</p> : <>
      <div className='role-access-identity'><strong>{view === 'roles' ? 'Role preview' : selected?.name || member}</strong><p>{view === 'roles' ? 'Roles: ' + policy.roles.filter(role => role.id === 'everyone' || previewRoles.includes(role.id)).map(role => role.name).join(', ') : member === policy.owner ? 'Server owner' : 'Roles: ' + memberServerRoles(policy, member).map(role => role.name).join(', ')}</p>{category && <p>Category: {layout.categories.find(value => value.id === category)?.name || 'Unavailable'}</p>}</div>
      <div className='role-access-filters'><label>Find an action<input type='search' value={permissionQuery} onChange={event => setPermissionQuery(event.target.value)}/></label><label>Show decisions<select value={filter} onChange={event => setFilter(event.target.value)}><option value='all'>All actions</option><option value='allowed'>Allowed by role rules</option><option value='blocked'>Blocked by role rules</option></select></label></div>
      <ul className='role-access-results' aria-label='Saved role decisions'>{rows.map(row => { const allowed = row.steps.at(-1)!.allowed; return <li key={row.permission}><div className='role-access-result'><strong>{row.label}</strong><span data-allowed={allowed}>{allowed ? <Check size={15}/> : <X size={15}/>} {allowed ? 'Allowed by role rules' : 'Blocked by role rules'}</span></div><details><summary>How this is decided</summary><ol>{row.steps.map(step => <li key={step.scope}><strong>{step.scope}: {step.allowed ? 'allow' : 'deny'}</strong><p>{step.reason}</p></li>)}</ol></details></li>; })}</ul>
      {!rows.length && <p className='role-empty'>No actions match these filters.</p>}
      {roomId && view === 'member' && <div className='role-access-native'><strong>Channel membership: {room ? joined ? 'Joined' : 'Not joined' : 'Not loaded on this device'}</strong><p>Server authority level: {power === null ? 'Unavailable' : power === Infinity ? 'Room creator' : power}.</p></div>}
      <p className='login-help'>These decisions explain this server’s role rules. Channel membership, server authority, other governing servers and deployment capabilities can also restrict an action. A role does not join someone to a channel or recover encrypted history.</p>
    </>}
  </details>;
}
