import { canInviteToRoom } from '@/lib/interactions';
import { canManageServerRoles, effectiveRolePermissions, memberRoleRank, readRolePolicy } from '@/lib/roles';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { accountArtworkOwner, requestApi } from '@/lib/api';
import { customInvitationUrl, validInvitationName } from '@/lib/invitation-link';
import { canNameInvitation } from '@/lib/invitation-management';
import { Field } from './auth-gateway';
import { copyText } from './action-menu';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Invitation = { id: string; creator: string; createdAt: number; expiresAt: number; uses: number; maxUses: number; revoked: boolean; email?: string; domain?: string; customSlug?: string; defaultRoleIds?: string[] };
export function InviteManager({ roomId }: { roomId: string }) {
  const [, redraw] = useState(0);
  useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  const client = getMatrixClient(), account = accountArtworkOwner(), actor = client?.getUserId();
  const scope = useRef({ client, account, actor, roomId, version: 0 });
  if (scope.current.client !== client || scope.current.account !== account || scope.current.actor !== actor || scope.current.roomId !== roomId) scope.current = { client, account, actor, roomId, version: scope.current.version + 1 };
  if (!canInviteToRoom(roomId)) return null;
  return <InviteManagerForm key={scope.current.version} roomId={roomId}/>;
}
function InviteManagerForm({ roomId }: { roomId: string }) {
  const [invites, setInvites] = useState<Invitation[]>([]), [hours, setHours] = useState(24), [uses, setUses] = useState(1), [email, setEmail] = useState(''), [domain, setDomain] = useState(''), [slug, setSlug] = useState('');
  const [link, setLink] = useState(''), [namedLink, setNamedLink] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [sendEmail, setSendEmail] = useState(false), [mailReady, setMailReady] = useState(false), [roles, setRoles] = useState<string[]>([]), [revoking, setRevoking] = useState<Invitation | null>(null);
  const owner = useRef({ client: getMatrixClient(), account: accountArtworkOwner(), actor: getMatrixClient()?.getUserId(), room: getMatrixClient()?.getRoom(roomId) }).current;
  const mounted = useRef(false), pending = useRef(false), loadVersion = useRef(0);
  const current = () => mounted.current && owner.client === getMatrixClient() && owner.account === accountArtworkOwner() && owner.actor === owner.client?.getUserId() && owner.room === owner.client?.getRoom(roomId) && canInviteToRoom(roomId);
  const allowed = canInviteToRoom(roomId), named = canNameInvitation(roomId), room = owner.room, me = owner.actor, policy = room?.isSpaceRoom() ? readRolePolicy(roomId) : null;
  const grants = policy && me ? effectiveRolePermissions(policy, me) : new Set(), rank = policy && me ? memberRoleRank(policy, me) : 0;
  const choices = policy && canManageServerRoles(roomId) ? policy.roles.filter(role => role.id !== 'everyone' && role.position < rank && role.permissions.every(permission => grants.has(permission))) : [];
  async function load() {
    const version = ++loadVersion.current;
    const result = await requestApi('/invitations?roomId=' + encodeURIComponent(roomId));
    if (current() && version === loadVersion.current) setInvites(Array.isArray(result.invitations) ? result.invitations : []);
  }
  useEffect(() => {
    mounted.current = true;
    if (allowed) {
      void load().catch(failure => { if (current()) setError(failure.message); });
      void requestApi('/auth/config').then(value => { if (current()) setMailReady(value.smtpConfigured === true); }).catch(() => {});
    }
    return () => { mounted.current = false; loadVersion.current++; };
  }, [allowed]);
  if (!owner.client || !room || !me || !allowed || owner.account !== accountArtworkOwner() || owner.client !== getMatrixClient() || owner.actor !== owner.client.getUserId()) return null;
  async function copy(value: string) { if (!current()) return; try { await copyText(value); } catch (failure) { if (current()) setError((failure as Error).message); } }
  return <section className="product-section"><h3>Invitation links</h3><form className="dialog-form" onSubmit={async event => {
    event.preventDefault(); if (!current() || pending.current) return;
    if (slug && (!canNameInvitation(roomId) || !validInvitationName(slug))) { setError('Choose a valid custom name while you have permission to manage this server.'); return; }
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await requestApi('/invitations', { roomId, expiresInHours: hours, maxUses: uses, email: email || undefined, domain: domain || undefined, defaultRoleIds: roles, sendEmail, customSlug: slug || undefined });
      if (!current()) return;
      setLink(result.url); setNamedLink(!!result.customSlug); if (result.warning) setError(result.warning);
      await load();
      if (current() && !result.warning) toast.success(result.emailSent ? 'Invitation created and emailed' : 'Invitation created');
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) { pending.current = false; setBusy(false); } }
  }}><fieldset disabled={busy}>
    {(named || !!slug) && <Field label="Custom invitation name (optional)"><input value={slug} maxLength={48} placeholder="guild-night" onChange={event => setSlug(event.target.value)}/></Field>}
    {!named && !!slug && <p>Your permission to name invitations changed. Clear the name to create a random invitation link, or ask a server manager.</p>}
    {named && <p>Custom links are public and guessable. Anyone who finds one can see the shared server name; email restrictions still control acceptance. Use 3-48 lowercase letters, numbers or single hyphens. A name stays reserved after expiry or revocation and cannot be reused.</p>}
    <Field label="Expires after (hours)"><input type="number" min={1} max={720} value={hours} onChange={event => setHours(Number(event.target.value))} required/></Field>
    <Field label="Maximum uses"><input type="number" min={1} max={1000} value={uses} onChange={event => setUses(Number(event.target.value))} required/></Field>
    <Field label="Restrict to verified email (optional)"><input type="email" value={email} onChange={event => { setEmail(event.target.value); if (!event.target.value) setSendEmail(false); }}/></Field>
    <Field label="Restrict email domain (optional)"><input placeholder="example.com" value={domain} onChange={event => setDomain(event.target.value)}/></Field>
    {mailReady && <label className="check-label"><input type="checkbox" checked={sendEmail} disabled={!email} onChange={event => setSendEmail(event.target.checked)}/>Email this invitation to the restricted address</label>}
    {!!choices.length && <fieldset><legend>Assign roles after joining</legend>{choices.map(role => <label className="check-label" key={role.id}><input type="checkbox" checked={roles.includes(role.id)} disabled={!roles.includes(role.id) && roles.length >= 20} onChange={event => setRoles(old => event.target.checked ? [...old, role.id] : old.filter(id => id !== role.id))}/>{role.icon} {role.name}</label>)}<p>Only roles you can currently assign are offered. Your authority and the role permissions are checked again when the invitation is accepted.</p></fieldset>}
    <button className="primary-button">Create invitation</button></fieldset></form>
    {link && <div className="notice"><div><p>{namedLink ? 'This custom link can also be copied from the invitation list.' : 'Copy this link now. It will not be displayed again.'}</p><code style={{ overflowWrap: 'anywhere' }}>{link}</code><button className="secondary-button" onClick={() => void copy(link)}>Copy invite</button></div></div>}
    <h4>Existing invitations</h4>{!invites.length && <p>No invitation links for this conversation.</p>}{invites.map(invitation => {
      const status = invitation.revoked ? 'Revoked' : invitation.expiresAt <= Date.now() ? 'Expired' : invitation.uses >= invitation.maxUses ? 'Used up' : 'Active';
      const url = validInvitationName(invitation.customSlug) ? customInvitationUrl(invitation.customSlug, location.origin) : '';
      return <div className="device-row" key={invitation.id}><span><strong>{invitation.uses || 0} / {invitation.maxUses} uses - {status}</strong>
        {url && <><small style={{ overflowWrap: 'anywhere' }}>{url}</small><button type="button" className="text-button" onClick={() => void copy(url)}>Copy custom link {invitation.customSlug}</button></>}
        <small>Created by {invitation.creator} on {new Date(invitation.createdAt).toLocaleString()}</small><small>Expires {new Date(invitation.expiresAt).toLocaleString()}</small>
        {(invitation.email || invitation.domain) && <small>Restricted to {invitation.email || '@' + invitation.domain}</small>}
        {!!invitation.defaultRoleIds?.length && <small>Roles: {invitation.defaultRoleIds.map(id => policy?.roles.find(role => role.id === id)?.name || id).join(', ')}</small>}
      </span>{!invitation.revoked && <button className="secondary-button" disabled={busy} onClick={() => { if (current()) setRevoking(invitation); }}>Revoke</button>}</div>;
    })}
    {error && <p className="connect-error" role="alert">{error}</p>}
    <Dialog open={!!revoking} onOpenChange={open => { if (!open && !busy) setRevoking(null); }}><DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>Revoke this invitation?</DialogTitle><DialogDescription>The shared link will stop working. An invitation already sent to Matrix or membership already granted cannot be undone by revoking the link. Custom names stay reserved.</DialogDescription></DialogHeader><div className="inline-actions"><button className="primary-button" disabled={busy} onClick={async () => {
      if (!current() || pending.current || !revoking) return;
      pending.current = true; setBusy(true); setError('');
      try { await requestApi('/invitations/' + encodeURIComponent(revoking.id), undefined, 'DELETE'); if (!current()) return; setRevoking(null); await load(); if (current()) toast.success('Invitation revoked'); }
      catch (failure) { if (current()) setError((failure as Error).message); }
      finally { if (current()) { pending.current = false; setBusy(false); } }
    }}>Revoke invitation</button><button className="secondary-button" disabled={busy} onClick={() => setRevoking(null)}>Cancel</button></div></DialogContent></Dialog>
  </section>;
}
export { RedeemInvite } from './redeem-invite';
