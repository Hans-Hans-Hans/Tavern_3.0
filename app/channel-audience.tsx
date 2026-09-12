import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { parseRolePolicy, readRolePolicy, rolesEvent, type ChannelAudience } from '@/lib/roles';
import { channelAdmissionAvailable, saveChannelAudience } from '@/lib/channel-admission';

export function ChannelAudienceSettings({ serverId, roomId, onChanged }: { serverId: string; roomId: string; onChanged: () => Promise<unknown> }) {
  const [, redraw] = useState(0), client = getMatrixClient(), account = accountArtworkOwner();
  useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  const owner = useRef({ client, account, serverId, roomId, generation: 0 });
  if (owner.current.client !== client || owner.current.account !== account || owner.current.serverId !== serverId || owner.current.roomId !== roomId) owner.current = { client, account, serverId, roomId, generation: owner.current.generation + 1 };
  const policy = readRolePolicy(serverId);
  if (!policy || policy.owner !== client?.getUserId()) return null;
  return <Editor key={owner.current.generation} serverId={serverId} roomId={roomId} onChanged={onChanged}/>;
}

function Editor({ serverId, roomId, onChanged }: { serverId: string; roomId: string; onChanged: () => Promise<unknown> }) {
  const [owner] = useState(() => ({ client: getMatrixClient()!, account: accountArtworkOwner() })), alive = useRef(true);
  const current = () => alive.current && owner.client === getMatrixClient() && owner.account === accountArtworkOwner();
  const [policy, setPolicy] = useState(() => readRolePolicy(serverId)), [previous, setPrevious] = useState<ChannelAudience | null>(null);
  const [enabled, setEnabled] = useState(false), [roleIds, setRoleIds] = useState<string[]>([]), [users, setUsers] = useState('');
  const [available, setAvailable] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function reload() {
    setBusy(true); setError(''); setNotice('');
    try {
      const [raw, ready] = await Promise.all([owner.client.getStateEvent(serverId, rolesEvent as any, ''), channelAdmissionAvailable()]);
      if (!current()) return;
      const parsed = parseRolePolicy(raw);
      if (!parsed || parsed.owner !== owner.client.getUserId()) throw new Error('Your server ownership or its role policy changed.');
      const saved = parsed.channelAdmissions?.[roomId] || null;
      setPolicy(parsed); setPrevious(saved); setEnabled(!!saved); setRoleIds(saved?.roleIds || []); setUsers((saved?.userIds || []).join('\n')); setAvailable(ready);
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void reload(); return () => { alive.current = false; }; }, []);
  async function save() {
    if (!current() || busy || !available) return;
    setBusy(true); setError(''); setNotice('');
    const desired = enabled ? { roleIds, userIds: users.split(/\s+/).filter(Boolean) } : null;
    try {
      await saveChannelAudience(serverId, roomId, desired, previous);
      if (!current()) return;
      setPrevious(desired); setNotice(enabled ? 'Private channel access saved. Eligible members can find and join this channel.' : 'Invite-only access saved.');
      try { await onChanged(); } catch { if (current()) setError('Access was saved, but the channel list needs a refresh.'); }
    } catch (failure) { if (current()) setError((failure as Error).message + ' Reload saved access to check any completed steps.'); }
    finally { if (current()) setBusy(false); }
  }
  return <section className='settings-section' aria-label='Private channel access'><h3>Private channel access</h3>
    <p className='login-help'>Choose who can discover and join this channel. The server owner keeps access. Role assignments update access automatically.</p>
    {!busy && !available && <p role='status'>Private-channel enforcement is not ready. Update and restart Synapse, then reload these settings.</p>}
    <form className='dialog-form' onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy || !available}>
      <label className='checkbox-row'><input type='checkbox' checked={enabled} onChange={event => setEnabled(event.target.checked)}/>Use selected roles and members</label>
      {enabled && <><fieldset><legend>Allowed roles</legend><div className='dialog-member-list'>{policy?.roles.map(role => <label className='checkbox-row' key={role.id}><input type='checkbox' checked={roleIds.includes(role.id)} onChange={event => setRoleIds(event.target.checked ? [...roleIds, role.id] : roleIds.filter(id => id !== role.id))}/>{role.icon} {role.name}</label>)}</div></fieldset>
        <label>Specific members<textarea value={users} maxLength={16000} rows={4} placeholder='One full Matrix ID per line' onChange={event => setUsers(event.target.value)}/></label>
        <p className='login-help'>Members must also belong to this server. With no selected roles or members, only the owner can access the channel.</p></>}
      {!enabled && <p className='login-help'>New members need a native channel invitation. Existing memberships remain.</p>}
      <p className='login-help'>When private access is removed, the server removes that membership in the background. History already downloaded to a device stays there.</p>
      <button className='primary-button'>Save channel access</button>
    </fieldset></form>
    <button type='button' className='secondary-button' disabled={busy} onClick={() => void reload()}>Reload saved access</button>
    {error && <p role='alert' className='connect-error'>{error}</p>}{notice && <p role='status'>{notice}</p>}
  </section>;
}
