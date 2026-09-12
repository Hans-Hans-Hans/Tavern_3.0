import { useState } from 'react';
import { getMatrixClient } from '@/lib/matrix';
import { readServerLayout } from '@/lib/community';
import { effectiveRolePermissions, memberServerRoles, nativeMemberPower, readRolePolicy, rolePermissions, type RolePermission } from '@/lib/roles';
export function AccessExplanation({ serverId, channelId }: { serverId: string; channelId?: string }) {
  const client = getMatrixClient(), server = client?.getRoom(serverId), policy = readRolePolicy(serverId);
  const [member, setMember] = useState(client?.getUserId() || ''), [channel, setChannel] = useState(channelId || ''), [query, setQuery] = useState('');
  if (!server || !policy || !client || server.getMyMembership() !== 'join') return null;
  const layout = readServerLayout(serverId), roomId = channelId || channel, room = client.getRoom(roomId), category = layout.channels.find(value => value.id === roomId)?.category;
  const base = effectiveRolePermissions(policy, member), categorized = effectiveRolePermissions(policy, member, undefined, category), final = effectiveRolePermissions(policy, member, roomId || undefined, category);
  const members = server.getJoinedMembers().filter(value => value.userId === member || value.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0,100);
  let power: number | null = null;
  try { if (room) power = nativeMemberPower(room, member); } catch { /* Unknown remains explicit. */ }
  const selected = server.getMember(member), joined = room?.getMember(member)?.membership === 'join';
  const permissions: RolePermission[] = ['send_messages','add_reactions','invite','join_calls','speak','video','screen_share','manage_channels'];
  return <details className="access-explanation"><summary>Explain a member’s access</summary><p>This reads the saved policy. Unsaved changes in the editor are not included.</p><label>Find a member<input type="search" value={query} onChange={event=>setQuery(event.target.value)}/></label><label>Member<select value={member} onChange={event=>setMember(event.target.value)}>{members.map(value=><option key={value.userId} value={value.userId}>{value.name}</option>)}</select></label>
    {!channelId&&<label>Channel<select value={channel} onChange={event=>setChannel(event.target.value)}><option value="">Server roles only</option>{layout.channels.map(value=><option key={value.id} value={value.id}>{client.getRoom(value.id)?.name||value.id}</option>)}</select></label>}
    {!selected||selected.membership!=='join'?<p>That member is no longer joined to this server. Choose a current member.</p>:<><p>{member===policy.owner?'This member owns the server.':'Roles: '+memberServerRoles(policy,member).map(role=>role.name).join(', ')}</p>{category&&<p>Category: {layout.categories.find(value=>value.id===category)?.name||'Unavailable'}</p>}
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Action</th><th>Server roles</th><th>After category rules</th><th>After channel rules</th></tr></thead><tbody>{permissions.map(permission=><tr key={permission}><td>{rolePermissions[permission]}</td><td>{base.has(permission)?'Allow':'Deny'}</td><td>{category?(categorized.has(permission)?'Allow':'Deny'):'Inherited'}</td><td>{roomId?(final.has(permission)?'Allow':'Deny'):'Inherited'}</td></tr>)}</tbody></table></div>
      <p>Role permissions combine first. Category rules apply next, then channel rules. At each level, a role denial wins over a role allowance; an explicit member rule takes precedence at that level.</p>
      {roomId&&<p>Native channel membership: {room?joined?'Joined':'Not joined':'Not available on this device'}. Native permission level: {power===null?'Unavailable':power===Infinity?'Room creator':power}.</p>}
      <p className="login-help">This explains this server’s role policy; native room permissions and other governing servers can also restrict access. A role allowance does not join a member to a channel or recover historical encryption keys. Channel membership and the server’s enforced admission rules determine who can enter.</p></>}
  </details>;
}
