import { useState } from 'react';
import { Check, Search, Users } from 'lucide-react';
import { assignRoleDraft, bulkRoleLimit, roleAssignmentIssue } from '@/lib/role-assignment';
import type { RolePolicy, ServerRole } from '@/lib/roles';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

type Props = { policy: RolePolicy; authority: RolePolicy; actor: string; role: ServerRole; room: any; current: () => boolean; onChange: (policy: RolePolicy) => void };
export function RoleMemberAssignments({ policy, authority, actor, role, room, current, onChange }: Props) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [add, setAdd] = useState(true);
  const [selected, setSelected] = useState<string[]>([]), [limit, setLimit] = useState(50), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [review, setReview] = useState<{ policy: RolePolicy; users: string[]; add: boolean } | null>(null);
  const members: { userId: string; name: string; membership: string }[] = [...(room?.getJoinedMembers() || [])].sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  const assigned = (user: string) => role.id === 'everyone' || (policy.members[user] || []).includes(role.id);
  const matches = members.filter(member => (member.name + ' ' + member.userId).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    && (filter === 'all' || assigned(member.userId) === (filter === 'assigned')));
  const shown = matches.slice(0, limit), total = room?.getJoinedMemberCount?.() ?? members.length;
  const issue = (user: string) => roleAssignmentIssue(authority, policy, actor, user, role, room, add)
    || (assigned(user) === add ? add ? 'Already assigned' : 'Not assigned' : null);
  const selectable = shown.filter(member => !issue(member.userId)).map(member => member.userId);
  const selectShown = [...new Set([...selected, ...selectable])];
  const name = (user: string) => members.find(member => member.userId === user)?.name || user;
  function prepare() {
    if (!current()) return;
    try {
      assignRoleDraft(policy, authority, actor, role.id, selected, add, room);
      setReview({ policy, users: [...selected], add }); setError('');
    } catch (e) { setError((e as Error).message); }
  }
  function apply() {
    if (!review || !current()) return;
    if (review.policy !== policy) { setError('Your role draft changed. Close this review and review the selection again.'); return; }
    try {
      const next = assignRoleDraft(policy, authority, actor, role.id, review.users, review.add, room);
      onChange(next); setNotice(`${review.users.length} member assignment${review.users.length === 1 ? '' : 's'} updated in this draft. Save roles and permissions to apply.`);
      setSelected([]); setReview(null); setError('');
    } catch (e) { setError((e as Error).message); }
  }
  return <div className='role-members-workspace'>
    <div className='role-members-heading'><Users size={20}/><div><h4>Members with {role.name}</h4><p>{members.filter(member => assigned(member.userId)).length} assigned in the loaded list · {members.length} of {total} members loaded</p></div></div>
    <p className='login-help'>{role.id === 'everyone' ? 'Every joined server member receives this role automatically.' : 'Choose members to add or remove this role. Other roles stay assigned. Changes are saved together with the rest of this role draft.'}</p>
    <div className='role-members-filters'><label><span><Search size={15}/>Find members for this role</span><input type='search' value={query} onChange={event => { setQuery(event.target.value); setLimit(50); }}/></label>
      <label>Show members<select value={filter} onChange={event => { setFilter(event.target.value); setLimit(50); }}><option value='all'>All loaded members</option><option value='assigned'>Assigned to this role</option><option value='unassigned'>Not assigned to this role</option></select></label></div>
    {role.id !== 'everyone' && <div className='role-bulk-toolbar'><label>Assignment action<select value={add ? 'add' : 'remove'} onChange={event => { setAdd(event.target.value === 'add'); setSelected([]); setError(''); setNotice(''); }}><option value='add'>Add this role</option><option value='remove'>Remove this role</option></select></label>
      <div className='role-bulk-selection'><span>{selected.length} of {bulkRoleLimit} selected</span><button type='button' className='secondary-button' disabled={!selectable.length || selectShown.length > bulkRoleLimit || selectShown.length === selected.length} onClick={() => { if (current()) setSelected(selectShown); }}>Select shown</button><button type='button' className='secondary-button' disabled={!selected.length} onClick={() => setSelected([])}>Clear selection</button></div>
      <p className='login-help'>Selections stay selected when searching or changing filters. Select shown applies only to eligible members currently displayed.</p>
    </div>}
    <ul className='role-member-list role-bulk-list' aria-label='Members for selected role'>{shown.map(member => {
      const reason = issue(member.userId), checked = selected.includes(member.userId);
      return <li key={member.userId}><label className='role-member-choice'>{role.id !== 'everyone' && <input type='checkbox' aria-label={'Select ' + member.name + ' (' + member.userId + ')'} checked={checked} disabled={!!reason && !checked || !checked && selected.length >= bulkRoleLimit} onChange={event => { if (!current()) return; setSelected(values => event.target.checked ? [...new Set([...values, member.userId])] : values.filter(user => user !== member.userId)); }}/>}<span className='role-member-avatar' aria-hidden='true'>{member.name.slice(0, 1).toLocaleUpperCase()}</span><span className='role-member-name'><strong>{member.name}{member.userId === actor ? ' (you)' : ''}</strong><small>{member.userId}</small>{reason && role.id !== 'everyone' && <small>{reason}</small>}</span></label>{assigned(member.userId) && <span className='role-assigned-label'><Check size={14}/>Assigned</span>}</li>;
    })}</ul>
    {!matches.length && <p className='role-empty'>No members match these filters. Any previous selection is retained.</p>}
    {matches.length > limit && <button type='button' className='secondary-button' onClick={() => setLimit(value => value + 50)}>Show more role members</button>}
    {members.length < total && room?.loadMembersIfNeeded && <button type='button' className='secondary-button' disabled={loading} onClick={async () => { if (!current()) return; setLoading(true); setError(''); try { await room.loadMembersIfNeeded(); if (current()) setNotice('Member list loaded. Search covers the available joined members.'); } catch (e) { if (current()) setError((e as Error).message); } finally { if (current()) setLoading(false); } }}>{loading ? 'Loading members…' : 'Load remaining server members'}</button>}
    {role.id !== 'everyone' && <button type='button' className='primary-button' disabled={!selected.length} onClick={prepare}>Review {selected.length} assignment change{selected.length === 1 ? '' : 's'}</button>}
    {notice && <p role='status' className='role-draft-notice'>{notice}</p>}
    {error && !review && <p role='alert' className='connect-error'>{error}</p>}
    <AlertDialog open={!!review} onOpenChange={open => { if (!open) { setReview(null); setError(''); } }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{review?.add ? 'Add' : 'Remove'} {role.name} {review?.add ? 'for' : 'from'} {review?.users.length} member{review?.users.length === 1 ? '' : 's'}?</AlertDialogTitle><AlertDialogDescription>This updates the open draft. Save roles and permissions afterward to apply it to the server. Role assignment does not invite members or join them to channels.</AlertDialogDescription></AlertDialogHeader>
      <ul className='role-review-members'>{review?.users.map(user => <li key={user}><strong>{name(user)}</strong><small>{user}</small></li>)}</ul>{error && <p role='alert' className='connect-error'>{error}</p>}
      <AlertDialogFooter><AlertDialogCancel>Keep editing selection</AlertDialogCancel><AlertDialogAction onClick={event => { event.preventDefault(); apply(); }}>Update role draft</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </div>;
}
