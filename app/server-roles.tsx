import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { canManageServerRoles, enableConferencePublication, defaultRolePolicy, effectiveRolePermissions, memberRoleRank, memberServerRoles, nativeMemberPower, readRolePolicy, rolePermissions, saveRolePolicy, type RolePermission, type RolePolicy, type ServerRole } from '@/lib/roles';
import { isPublicationPermission } from '@/lib/conference-publication';
import { permissionGroups, removeRole, roleColors, roleCopy, roleIcons } from '@/lib/role-editor';
import { serverChannelIds } from '@/lib/community';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRoleEditorOwner } from './role-editor-owner';
import './server-roles.css';

export function ServerRoleBadges({ serverId, userId }: { serverId: string; userId: string }) {
  const [, redraw] = useState(0);
  useEffect(() => onMatrixUpdate(() => redraw(v => v + 1)), []);
  const policy = readRolePolicy(serverId);
  if (!policy) return null;
  return <div className="inline-actions" style={{ flexWrap: 'wrap' }}>{userId === policy.owner && <span className="community-role">👑 Owner</span>}{memberServerRoles(policy, userId).map(role => <span className="community-role" style={{ color: role.color || undefined }} key={role.id}>{role.icon} {role.name}</span>)}</div>;
}

import { AccessExplanation } from './access-explanation';
type Props = { serverId: string; channelId?: string; enabled: boolean; onChanged?: () => Promise<unknown> };
export function ServerRoles(props: Props) { return <ServerRoleEditor key={props.serverId + ':' + (props.channelId || '')} {...props}/>; }
function ServerRoleEditor({ serverId, channelId, enabled, onChanged }: Props) {
  const owner = useRoleEditorOwner(serverId, channelId), original = readRolePolicy(serverId);
  const [channelRoom] = useState(() => channelId ? owner.client?.getRoom(channelId) : null);
  const scopeCurrent = () => {
    if (!owner.current()) return false;
    if (!channelId) return true;
    const server = owner.client?.getRoom(serverId), child = owner.client?.getRoom(channelId);
    const parent = child?.currentState.getStateEvents('m.space.parent', serverId)?.getContent();
    const link = server?.currentState.getStateEvents('m.space.child', channelId)?.getContent();
    return !!(child && child === channelRoom && child.getMyMembership() === 'join' && !child.isSpaceRoom()
      && parent?.canonical === true && Array.isArray(parent.via) && parent.via.length
      && Array.isArray(link?.via) && link.via.length);
  };
  const [policy, setPolicy] = useState<RolePolicy>(() => original || defaultRolePolicy(owner.user));
  const [previous, setPrevious] = useState<RolePolicy | null>(() => original);
  const [selected, setSelected] = useState('everyone'), [query, setQuery] = useState(''), [permissionQuery, setPermissionQuery] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [tab, setTab] = useState('appearance');
  const [member, setMember] = useState(''), [memberQuery, setMemberQuery] = useState('');
  const [channel, setChannel] = useState(channelId || ''), [targetType, setTargetType] = useState<'roles' | 'users'>('roles'), [target, setTarget] = useState('');
  if (!owner.current() || !enabled || !canManageServerRoles(serverId)) return null;
  if (channelId && (!scopeCurrent() || !original)) return <p role="status">Channel role permissions are unavailable. Join the channel and its governing server, then reopen these settings after server roles are enabled.</p>;
  const me = owner.user, room = owner.client?.getRoom(serverId), authority = original || defaultRolePolicy(me);
  const myRank = memberRoleRank(authority, me), grants = effectiveRolePermissions(authority, me);
  const ordered = [...policy.roles].sort((a, b) => b.position - a.position), role = policy.roles.find(item => item.id === selected) || policy.roles[0];
  const canEdit = (value: ServerRole) => value.position < myRank;
  const dirty = JSON.stringify(policy) !== JSON.stringify(previous || defaultRolePolicy(me));
  const current = () => scopeCurrent() && canManageServerRoles(serverId) && (!channelId || effectiveRolePermissions(readRolePolicy(serverId) || defaultRolePolicy(''), owner.user).has('manage_channels'));
  const assertCurrent = () => { if (!current()) throw new Error('Your channel, server relationship or role authority changed. Reopen channel permissions.'); };
  const visiblePermission = (permission: RolePermission) => (policy.callPublicationVersion === 1 || !isPublicationPermission(permission)) && rolePermissions[permission].toLowerCase().includes(permissionQuery.toLowerCase().trim());
  const update = (change: Partial<ServerRole>) => setPolicy(value => ({ ...value, roles: value.roles.map(item => item.id === role.id ? { ...item, ...change } : item) }));
  function reload() {
    if (!current()) return;
    const saved = readRolePolicy(serverId); setPolicy(saved || defaultRolePolicy(me)); setPrevious(saved); setError('');
    if (!saved?.roles.some(item => item.id === selected)) setSelected('everyone');
  }
  function add(source?: ServerRole) {
    try {
      if (source?.permissions.some(permission => !grants.has(permission))) throw new Error('You cannot duplicate permissions you do not have.');
      const created = roleCopy(policy, myRank, crypto.randomUUID(), source);
      setPolicy(value => ({ ...value, roles: [...value.roles, created] })); setSelected(created.id); setQuery(''); setTab('appearance'); setError('');
    } catch (e) { setError((e as Error).message); }
  }
  function move(step: number, otherId?: string) {
    const at = ordered.findIndex(item => item.id === role.id), other = otherId ? ordered.find(item => item.id === otherId) : ordered[at + step];
    if (!other || other.id === 'everyone' || role.id === 'everyone' || !canEdit(role) || !canEdit(other)) return;
    setPolicy(value => ({ ...value, roles: value.roles.map(item => item.id === role.id ? { ...item, position: other.position } : item.id === other.id ? { ...item, position: role.position } : item) }));
  }
  async function save() {
    if (!current()) return;
    setBusy(true); setError('');
    try { const saved = await saveRolePolicy(serverId, policy, previous, assertCurrent, channelId); if (!current()) return; setPolicy(saved); setPrevious(saved); await onChanged?.(); if (current()) toast.success(channelId ? 'Channel role permissions saved' : 'Server roles saved'); }
    catch (e) { if (current()) setError((e as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  async function migrate() {
    if (!current() || dirty) return;
    setBusy(true); setError('');
    try { const saved = await enableConferencePublication(serverId); if (!current()) return; setPolicy(saved); setPrevious(saved); await onChanged?.(); if (current()) toast.success('Conference permissions enabled; existing publishing rights preserved'); }
    catch (e) { if (current()) setError((e as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  const assignableMembers = room?.getJoinedMembers().filter(item => item.userId !== me && memberRoleRank(authority, item.userId) < myRank && nativeMemberPower(room, item.userId) < nativeMemberPower(room, me)) || [];
  const assignment = assignableMembers.find(item => item.userId === member);
  const rolePosition = ordered.findIndex(item => item.id === role.id);
  return <section className="channel-admin server-roles-editor">
    <h3>{channelId ? 'Channel role permissions' : 'Server roles and permissions'}</h3>
    <AccessExplanation serverId={serverId} channelId={channelId}/>
    <p className="login-help">{channelId ? `Override permissions for ${channelRoom?.name || 'this channel'} in ${room?.name || 'this server'}. Other governing servers and native room permissions still apply. Role membership never joins someone to a channel.` : 'Give each role a recognizable look, choose its permissions, and assign it to members. Higher roles can manage only roles and members below them. Native Matrix permissions also apply.'}</p>
    <form className="dialog-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy}>
        {!channelId && <><div className="role-workbench">
          <nav className="role-navigation" aria-label="Server roles">
            <label>Find a role<input type="search" value={query} onChange={event => setQuery(event.target.value)}/></label>
            <div className="role-navigation-list">{ordered.filter(item => item.name.toLowerCase().includes(query.toLowerCase().trim())).map(item => <button type="button" key={item.id} aria-label={'Edit ' + item.name + ' (' + item.id + ')'} aria-pressed={item.id === role.id}
              draggable={item.id !== 'everyone' && canEdit(item)} onDragStart={event => { setSelected(item.id); event.dataTransfer.setData('text/tavern-role', item.id); }}
              onDragOver={event => { if (item.id !== 'everyone' && canEdit(item)) event.preventDefault(); }}
              onDrop={event => { event.preventDefault(); const from = policy.roles.find(candidate => candidate.id === event.dataTransfer.getData('text/tavern-role')); if (from?.id === role.id) move(0, item.id); }}
              onClick={() => setSelected(item.id)}><span className="role-nav-name"><span className="role-dot" style={{ background: item.color || 'var(--foreground)' }}/><span>{item.icon} {item.name}</span></span><small>{item.id === 'everyone' ? 'Everyone' : Object.values(policy.members).filter(ids => ids.includes(item.id)).length + ' assigned'}{!canEdit(item) ? ' · Read only' : ''}</small></button>)}</div>
            {!ordered.some(item => item.name.toLowerCase().includes(query.toLowerCase().trim())) && <p>No matching roles.</p>}
            <button type="button" className="secondary-button" disabled={policy.roles.length >= 100} onClick={() => add()}><Plus size={16}/>Add role</button>
          </nav>
          <div className="role-detail">
            <div className="role-preview" aria-label="Role preview"><span className="role-preview-avatar" aria-hidden="true">A</span><div><strong style={{ color: role.color || undefined }}>{role.icon} Avery</strong><span className="community-role" style={{ color: role.color || undefined }}>{role.icon} {role.name}</span><small>Preview of the role badge and member color</small></div></div>
            {!canEdit(role) && <p>This role is at or above your authority. Its settings are read only.</p>}
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList aria-label="Role settings"><TabsTrigger value="appearance">Appearance</TabsTrigger><TabsTrigger value="permissions">Permissions</TabsTrigger><TabsTrigger value="members">Members</TabsTrigger></TabsList>
              <TabsContent value="appearance"><fieldset disabled={!canEdit(role)} className="role-settings-fields">
                <label>Role name<input aria-label="Role name" maxLength={60} required value={role.name} onChange={event => update({ name: event.target.value })}/></label>
                <label>Role icon<input aria-label="Role icon" maxLength={16} value={role.icon} placeholder="Emoji or short symbol" onChange={event => update({ icon: event.target.value })}/></label>
                <div className="role-icon-palette" aria-label="Suggested role icons">{roleIcons.map(icon => <button type="button" key={icon} aria-label={'Use role icon ' + icon} aria-pressed={role.icon === icon} onClick={() => update({ icon })}>{icon}</button>)}<button type="button" onClick={() => update({ icon: '' })}>Clear icon</button></div>
                <div className="role-color-controls"><label>Role color<input aria-label="Role color" type="color" value={role.color || '#b78a56'} onChange={event => update({ color: event.target.value })}/></label><button type="button" className="secondary-button" onClick={() => update({ color: '' })}>Use default color</button></div>
                <div className="role-color-palette" aria-label="Suggested role colors">{roleColors.map(color => <button type="button" key={color} aria-label={'Use role color ' + color} aria-pressed={role.color === color} style={{ background: color }} onClick={() => update({ color })}/>)}</div>
                <label className="check-label"><input type="checkbox" checked={role.mentionable} onChange={event => update({ mentionable: event.target.checked })}/>Allow members to mention this role</label>
                <p className="login-help">This makes the role available in Tavern’s composer. Other encrypted clients can still name people directly.</p>
                <label className="check-label"><input type="checkbox" checked={role.separate} onChange={event => update({ separate: event.target.checked })}/>Display this role separately in the member list</label>
                <div className="role-actions"><button type="button" className="secondary-button" disabled={role.permissions.some(permission => !grants.has(permission))} onClick={() => add(role)}><Copy size={16}/>Duplicate role</button>{role.id !== 'everyone' && <><button type="button" disabled={!ordered[rolePosition - 1] || !canEdit(ordered[rolePosition - 1])} onClick={() => move(-1)} aria-label="Move role higher"><ArrowUp size={16}/></button><button type="button" disabled={!ordered[rolePosition + 1] || ordered[rolePosition + 1].id === 'everyone'} onClick={() => move(1)} aria-label="Move role lower"><ArrowDown size={16}/></button><button type="button" onClick={() => { setPolicy(value => removeRole(value, role.id)); setSelected('everyone'); }}><Trash2 size={16}/>Remove role</button></>}</div>
                <p className="login-help">New and duplicated roles are unassigned. Changes, including removal and order, take effect when you save.</p>
              </fieldset></TabsContent>
              <TabsContent value="permissions"><div className="role-settings-fields">
                <label>Find a permission<input type="search" value={permissionQuery} onChange={event => setPermissionQuery(event.target.value)}/></label>
                {permissionGroups.map(group => { const permissions = group.permissions.filter(visiblePermission); return permissions.length ? <fieldset key={group.name} disabled={!canEdit(role)} className="role-permission-group"><legend>{group.name}</legend>{permissions.map(permission => <label key={permission} className="check-label"><input type="checkbox" checked={role.permissions.includes(permission)} disabled={!grants.has(permission)} onChange={event => update({ permissions: event.target.checked ? [...role.permissions, permission] : role.permissions.filter(item => item !== permission) })}/>{rolePermissions[permission]}</label>)}</fieldset> : null; })}
                {!permissionGroups.some(group => group.permissions.some(visiblePermission)) && <p>No matching permissions.</p>}
                <p className="login-help">Encrypted messages share one send permission. File contents, links, and media origin cannot be inspected by these permissions.</p>
                {!policy.callPublicationVersion ? <div className="role-publication-note"><p>Voice and video publishing keeps its existing behavior until the owner enables the separate conference controls. Enabling preserves saved settings and adds audio, camera, and screen publishing to the Member role.</p>{original && me === original.owner && <button type="button" className="secondary-button" disabled={dirty} onClick={() => void migrate()}>Enable conference publication permissions</button>}{dirty && <p>Save changes or reload saved roles before enabling conference permissions.</p>}</div> : <p className="login-help">Speak includes microphone and screen audio. Camera and screen sharing restrict declared video sources, not the origin of pixels. Restrictions require the configured Tavern SFU extension. Restoring permissions may require a fresh join; devices never start automatically.</p>}
              </div></TabsContent>
              <TabsContent value="members"><div className="role-settings-fields"><p>{role.id === 'everyone' ? 'Every joined server member receives this role automatically.' : 'Members assigned to this role. Use the assignment editor below to change their roles.'}</p><ul className="role-member-list">{room?.getJoinedMembers().filter(item => role.id === 'everyone' || policy.members[item.userId]?.includes(role.id)).map(item => <li key={item.userId}><strong>{item.name}</strong><small>{item.userId}</small>{assignableMembers.some(candidate => candidate.userId === item.userId) && <button type="button" className="secondary-button" onClick={() => setMember(item.userId)}>Edit member roles</button>}</li>)}</ul></div></TabsContent>
            </Tabs>
          </div>
        </div>
        <details className="role-advanced" open={!!member || undefined}>
          <summary>Assign member roles</summary><label>Find a member<input type="search" value={memberQuery} onChange={event => setMemberQuery(event.target.value)}/></label>
          <label>Member<select value={member} onChange={event => setMember(event.target.value)}><option value="">Choose a member</option>{assignableMembers.filter(item => item.userId === member || (item.name + ' ' + item.userId).toLowerCase().includes(memberQuery.toLowerCase())).map(item => <option value={item.userId} key={item.userId}>{item.name} ({item.userId})</option>)}</select></label>
          {assignment && <div className="role-assignment-list">{policy.roles.filter(item => item.id !== 'everyone' && canEdit(item)).map(item => <label key={item.id} className="check-label"><input type="checkbox" checked={(policy.members[member] || []).includes(item.id)} disabled={!(policy.members[member] || []).includes(item.id) && item.permissions.some(permission => !grants.has(permission))} onChange={event => setPolicy(value => ({ ...value, members: { ...value.members, [member]: event.target.checked ? [...(value.members[member] || []), item.id] : (value.members[member] || []).filter(id => id !== item.id) } }))}/><span style={{ color: item.color || undefined }}>{item.icon} {item.name}</span></label>)}</div>}
        </details></>}
        {grants.has('manage_channels') && <details className="role-advanced" open={channelId ? true : undefined}><summary>Channel overrides</summary>
          <p>Channels inherit category permissions first. Choose a role or member to override an individual channel.</p>
          {channelId ? <p><strong>{channelRoom?.name || channelId}</strong> · <code>{channelId}</code></p> : <label>Channel<select value={channel} onChange={event => setChannel(event.target.value)}><option value="">Choose a channel</option>{serverChannelIds(serverId).map(id => <option key={id} value={id}>{owner.client?.getRoom(id)?.name || id}</option>)}</select></label>}
          <label>Apply to<select value={targetType} onChange={event => { setTargetType(event.target.value as 'roles' | 'users'); setTarget(''); }}><option value="roles">A role</option><option value="users">One member</option></select></label>
          <label>{targetType === 'roles' ? 'Role' : 'Member'}<select value={target} onChange={event => setTarget(event.target.value)}><option value="">Choose a target</option>{targetType === 'roles' ? policy.roles.filter(canEdit).map(item => <option key={item.id} value={item.id}>{item.name}</option>) : assignableMembers.map(item => <option key={item.userId} value={item.userId}>{item.name}</option>)}</select></label>
          {channel && target && permissionGroups.map(group => { const permissions = group.permissions.filter(permission => !['manage_roles', 'manage_server', 'manage_nicknames'].includes(permission) && (policy.callPublicationVersion === 1 || !isPublicationPermission(permission))); return permissions.length ? <fieldset key={group.name} className="role-permission-group"><legend>{group.name}</legend>{permissions.map(permission => <label key={permission}>{rolePermissions[permission]}<select value={policy.overrides[channel]?.[targetType]?.[target]?.[permission] || 0} onChange={event => setPolicy(value => { const old = value.overrides[channel] || { roles: {}, users: {} }; return { ...value, overrides: { ...value.overrides, [channel]: { ...old, [targetType]: { ...old[targetType], [target]: { ...old[targetType][target], [permission]: Number(event.target.value) } } } } }; })}><option value="0">Inherited</option><option value="1" disabled={!grants.has(permission)}>Allow</option><option value="-1">Deny</option></select></label>)}</fieldset> : null; })}
          {channelId && <div className="notice"><div><strong>Allow only a chosen role to join voice</strong><p>In this channel's category permissions, set the Member role's Join calls and conferences to Deny. Then set that permission to Allow for the chosen role here. Keep the Member override here Inherited: a channel-level Member Deny would also block the chosen role. The category rule affects every channel in that category.</p><p>Alternatively, remove the base Join calls and conferences grant from Member in Server roles before allowing the chosen role here; that changes inheritance across the server. An Allow by itself does not exclude other roles with existing access. Invited members must still join the channel.</p></div></div>}
          <p className="login-help">Role denies take precedence over role allows. Individual member overrides take precedence over role overrides. The server owner retains control; room membership controls access to history.</p>
        </details>}
        <div className="role-save-bar"><span role="status">{dirty ? 'Unsaved role changes' : 'No unsaved changes'}</span><button className="primary-button" disabled={!current() || !!previous && !dirty}>{busy ? 'Saving…' : channelId ? 'Save channel role permissions' : previous ? 'Save roles and permissions' : 'Enable server roles'}</button><button type="button" className="secondary-button" onClick={reload}>Reload saved roles</button></div>
      </fieldset>
      {error && <p role="alert" className="connect-error">{error}</p>}
    </form>
  </section>;
}
