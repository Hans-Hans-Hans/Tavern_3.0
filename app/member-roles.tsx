import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getMatrixClient } from '@/lib/matrix';
import { canAssignMemberRoles, effectiveRolePermissions, memberRoleRank, readRolePolicy, saveMemberRoles } from '@/lib/roles';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRoleEditorOwner } from './role-editor-owner';
import './server-roles.css';
const eventName = 'tavern:member-roles';
export function openMemberRoles(serverId: string, userId: string) { window.dispatchEvent(new CustomEvent(eventName, { detail: { serverId, userId } })); }
export function MemberRolesDialog({ onChanged }: { onChanged?: () => Promise<unknown> }) {
  const [target, setTarget] = useState<{ serverId: string; userId: string } | null>(null);
  useEffect(() => {
    const show = (event: Event) => { const detail = (event as CustomEvent).detail; if (typeof detail?.serverId === 'string' && typeof detail?.userId === 'string' && canAssignMemberRoles(detail.serverId, detail.userId)) setTarget({ serverId: detail.serverId, userId: detail.userId }); };
    window.addEventListener(eventName, show); return () => window.removeEventListener(eventName, show);
  }, []);
  return <Dialog open={!!target} onOpenChange={open => { if (!open) setTarget(null); }}><DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>Member roles</DialogTitle><DialogDescription>{target ? getMatrixClient()?.getRoom(target.serverId)?.getMember(target.userId)?.name || target.userId : 'Manage server roles for this member.'}</DialogDescription></DialogHeader>{target && <MemberRoleEditor {...target} onChanged={onChanged} onUnavailable={() => setTarget(null)}/>}</DialogContent></Dialog>;
}
type Props = { serverId: string; userId: string; onChanged?: () => Promise<unknown>; onUnavailable?: () => void };
export function MemberRoleEditor(props: Props) { return <MemberRoleForm key={JSON.stringify([props.serverId, props.userId])} {...props}/>; }
function MemberRoleForm({ serverId, userId, onChanged, onUnavailable }: Props) {
  const owner = useRoleEditorOwner(serverId, userId);
  const initial = readRolePolicy(serverId)?.members[userId] || [];
  const [selected, setSelected] = useState(initial), [previous, setPrevious] = useState(initial);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [query, setQuery] = useState('');
  const policy = readRolePolicy(serverId), me = owner.user;
  const current = () => owner.current() && canAssignMemberRoles(serverId, userId);
  const available = current();
  useEffect(() => { if (!available) onUnavailable?.(); }, [available, onUnavailable]);
  if (!policy || !me || !available) return <p>You can manage only members and roles below your authority.</p>;
  const grants = effectiveRolePermissions(policy, me), rank = memberRoleRank(policy, me);
  const roles = [...policy.roles].sort((a, b) => b.position - a.position);
  const checked = (id: string) => id === 'everyone' || selected.includes(id);
  async function save() {
    if (!current()) return;
    setBusy(true); setError('');
    try {
      const saved = await saveMemberRoles(serverId, userId, selected, previous);
      if (!current()) return;
      const ids = saved.members[userId] || []; setSelected(ids); setPrevious(ids);
      await onChanged?.(); if (current()) toast.success('Member roles saved');
    } catch (e) { if (current()) setError((e as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  return <form className="dialog-form role-member-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
    <p>Every member keeps the default Member role. You can grant only permissions you have, and only roles below your highest role.</p>
    <p role="status">{JSON.stringify([...selected].sort()) !== JSON.stringify([...previous].sort()) ? 'Unsaved member role changes' : 'Assignments are up to date'}</p>
    <div className="inline-actions" aria-label="Selected member roles" style={{ flexWrap: 'wrap' }}>{roles.filter(role => checked(role.id)).map(role => <span key={role.id} className="community-role" style={{ color: role.color || undefined }}>{role.icon} {role.name}</span>)}</div>
    <label>Find a role<input type="search" value={query} onChange={event => setQuery(event.target.value)}/></label>
    <fieldset disabled={busy} className="role-assignment-list">{roles.filter(role => role.name.toLowerCase().includes(query.toLowerCase().trim())).map(role => {
      const active = checked(role.id), allowed = role.id !== 'everyone' && role.position < rank && (active || role.permissions.every(permission => grants.has(permission)));
      return <label className="check-label" key={role.id}><input type="checkbox" checked={active} disabled={!allowed} onChange={event => setSelected(ids => event.target.checked ? [...ids, role.id] : ids.filter(id => id !== role.id))}/><span style={{ color: role.color || undefined }}>{role.icon} {role.name}</span></label>;
    })}</fieldset>
    {!roles.some(role => role.name.toLowerCase().includes(query.toLowerCase().trim())) && <p>No matching roles. Selected assignments are retained.</p>}
    <div className="product-actions"><button className="primary-button" disabled={busy}>Save member roles</button><button className="secondary-button" type="button" disabled={busy} onClick={() => { if (!current()) return; const ids = readRolePolicy(serverId)?.members[userId] || []; setSelected(ids); setPrevious(ids); setError(''); }}>Reload assignments</button></div>
    {error && <p role="alert" className="connect-error">{error}</p>}
  </form>;
}
