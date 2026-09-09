import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { requestApi, type AccountSession } from '@/lib/api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Field } from './auth-gateway';

type Security = { managed: boolean; email?: string; emailVerified?: boolean; mfaMethods?: string[]; passwordChangeRequired?: boolean; accessBlocked?: string | boolean };
type User = { name: string; displayname?: string; admin: boolean; deactivated?: boolean; locked?: boolean; suspended?: boolean; creation_ts?: number; last_seen_ts?: number; user_type?: string; serviceAccount?: boolean; security?: Security };
type UserPage = { users: User[]; next_token?: string | number | null; total: number | null; totalBeforeLocalFilters?: number; scanned?: number; boundedPageFiltering?: boolean };
type Page<T> = { items: T[]; total: number; next?: number | null };
type Device = { id: string; deviceId: string; name?: string; createdAt: number; lastSeen: number; expiresAt?: number; ip?: string };
type UserDetail = { deactivation?: { id: string; phase: string; issue: string } | null; user: User; security: Security; serviceAccount: boolean; sessions: Page<Device>; rooms: Page<string>; storage: { usedBytes: number | null; quotaBytes: number | null; quotaOverrideBytes?: number | null; usageInitialized: boolean; uncertainReservations: number }; audit: { id: string | number; created: number; actor: string; action: string; target: string; detail: string }[] };
type Filters = { search: string; role: string; status: string; mfa: string; email: string; sort: string; dir: string };
type Action = 'revoke_sessions' | 'reset_mfa' | 'require_password_change' | 'suspend' | 'enable' | 'deactivate' | 'set_quota' | 'resend_verification';
const initialFilters: Filters = { search: '', role: 'all', status: 'all', mfa: 'all', email: 'all', sort: 'name', dir: 'f' };
const time = (value?: number) => value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleString() : 'Unavailable';
const bytes = (value: number | null | undefined) => typeof value === 'number' ? (value / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' MiB' : 'Unavailable';
const status = (user: User, security = user.security) => user.deactivated ? 'Deactivated' : user.locked || security?.accessBlocked === 'locked' ? 'Locked' : security?.accessBlocked || user.suspended ? 'Suspended' : 'Active';
const emailStatus = (security?: Security) => !security?.managed ? 'Not managed by Tavern' : !security.email ? 'No email' : security.emailVerified ? 'Verified' : 'Unverified';
const mfaStatus = (security?: Security) => !security?.managed ? 'Not managed by Tavern' : security.mfaMethods?.length ? security.mfaMethods.map(method => method === 'totp' ? 'Authenticator' : method === 'email' ? 'Email' : method).join(', ') : 'Disabled';
const hasNext = (value: string | number | null | undefined) => value !== undefined && value !== null && value !== '';

export function AdminUsers({ session }: { session: AccountSession }) {
  const [filters, setFilters] = useState(initialFilters), [applied, setApplied] = useState(initialFilters);
  const [pages, setPages] = useState<string[]>([]), [revision, setRevision] = useState(0);
  const [data, setData] = useState<UserPage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState(''), [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!session.admin) return;
    let live = true; setBusy(true); setError(''); setData(null);
    const query = new URLSearchParams({ ...applied, from: pages.at(-1) || '0', limit: '50' });
    void requestApi<UserPage>('/admin/users?' + query).then(value => { if (live) setData(value); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [applied, pages, revision, session.admin]);
  const refresh = () => setRevision(value => value + 1);
  if (!session.admin) return <p role='alert'>Instance administrator access is required.</p>;
  return <section className='product-section'>
    <form className='dialog-form' onSubmit={event => { event.preventDefault(); setPages([]); setApplied({ ...filters, search: filters.search.trim() }); }}>
      <Field label='Search users'><input type='search' placeholder='Username or display name' maxLength={255} value={filters.search} onChange={event => setFilters({ ...filters, search: event.target.value })}/></Field>
      <div className='product-actions'>
        <Field label='Role'><select value={filters.role} onChange={event => setFilters({ ...filters, role: event.target.value })}><option value='all'>All roles</option><option value='admin'>Instance administrator</option><option value='user'>User</option></select></Field>
        <Field label='Account status'><select value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}><option value='all'>All statuses</option><option value='active'>Active</option><option value='locked'>Locked</option><option value='deactivated'>Deactivated</option></select></Field>
        <Field label='Two-step verification'><select value={filters.mfa} onChange={event => setFilters({ ...filters, mfa: event.target.value })}><option value='all'>Any verification</option><option value='enabled'>Enabled</option><option value='disabled'>Disabled</option><option value='unmanaged'>Not managed by Tavern</option></select></Field>
        <Field label='Email status'><select value={filters.email} onChange={event => setFilters({ ...filters, email: event.target.value })}><option value='all'>Any email</option><option value='verified'>Verified</option><option value='unverified'>Unverified</option><option value='unset'>No email</option><option value='unmanaged'>Not managed by Tavern</option></select></Field>
        <Field label='Sort users by'><select value={filters.sort} onChange={event => setFilters({ ...filters, sort: event.target.value })}><option value='name'>Username</option><option value='creation_ts'>Creation date</option></select></Field>
        <Field label='Sort direction'><select value={filters.dir} onChange={event => setFilters({ ...filters, dir: event.target.value })}><option value='f'>Ascending</option><option value='b'>Descending</option></select></Field>
      </div>
      <div className='product-actions'><button className='secondary-button' disabled={busy}>Apply user filters</button><button type='button' className='secondary-button' disabled={busy} onClick={() => { setFilters(initialFilters); setApplied({ ...initialFilters }); setPages([]); }}>Reset filters</button><button type='button' className='primary-button' onClick={() => setCreating(true)}>Create user</button></div>
    </form>
    {error && <p role='alert' className='connect-error'>{error} <button className='secondary-button' onClick={refresh}>Retry loading users</button></p>}
    {busy && <p role='status'>Loading users…</p>}
    {data && <><div className='admin-table-wrap'><table className='admin-table'><thead><tr><th scope='col'>User</th><th scope='col'>Role</th><th scope='col'>Status</th><th scope='col'>Email</th><th scope='col'>Two-step verification</th><th scope='col'>Created</th><th scope='col'>Actions</th></tr></thead><tbody>{data.users.map(user => <tr key={user.name}><td><strong>{user.displayname || user.name}</strong><br/><code>{user.name}</code>{user.serviceAccount && <small> · Service account</small>}</td><td>{user.admin ? 'Instance administrator' : 'User'}</td><td>{status(user)}{user.security?.passwordChangeRequired && <small> · Password change required</small>}</td><td>{emailStatus(user.security)}</td><td>{mfaStatus(user.security)}</td><td>{time(user.creation_ts)}</td><td><button className='secondary-button' aria-label={'Manage ' + user.name} onClick={() => setSelected(user.name)}>Manage</button></td></tr>)}</tbody></table></div>
      {!data.users.length && <p>{hasNext(data.next_token) ? 'No matching users on this page. Continue to the next page to check more accounts.' : 'No matching users on this page.'}</p>}
      <div className='product-actions'><button className='secondary-button' disabled={busy || !pages.length} onClick={() => setPages(previous => previous.slice(0, -1))}>Previous user page</button><span>Page {pages.length + 1}{data.total !== null ? ' · ' + data.total.toLocaleString() + ' users' : ' · Matching total unavailable'}</span><button className='secondary-button' disabled={busy || !hasNext(data.next_token)} onClick={() => setPages(previous => [...previous, String(data.next_token)])}>Next user page</button></div>
      {data.boundedPageFiltering && <p className='login-help'>Filters are applied to up to 50 accounts per page. A page can be empty while more accounts remain.</p>}
    </>}
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(''); }}><DialogContent className='tavern-dialog settings-dialog'><DialogHeader><DialogTitle>User administration</DialogTitle><DialogDescription>{selected}</DialogDescription></DialogHeader>{selected && <UserDetails key={selected} userId={selected} operator={session} onChanged={refresh}/>}</DialogContent></Dialog>
    <Dialog open={creating} onOpenChange={setCreating}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Create user</DialogTitle><DialogDescription>Create a local account. An email supplied here remains unverified until its owner verifies it.</DialogDescription></DialogHeader>{creating && <CreateUser onCreated={() => { setCreating(false); refresh(); }}/>}</DialogContent></Dialog>
  </section>;
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState(''), [displayName, setDisplayName] = useState(''), [password, setPassword] = useState(''), [email, setEmail] = useState(''), [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <form className='dialog-form' onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await requestApi('/admin/users', { username, displayName, password, email, admin }); setPassword(''); toast.success('User created'); onCreated(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }}><Field label='Username'><input required autoComplete='off' maxLength={64} pattern='[a-z0-9._=\-]+' value={username} onChange={event => setUsername(event.target.value)}/></Field><p className='login-help'>Use lowercase letters, numbers, dots, underscores, equals signs, or hyphens.</p><Field label='Display name'><input maxLength={100} value={displayName} onChange={event => setDisplayName(event.target.value)}/></Field><Field label='Email (optional)'><input type='email' autoComplete='off' maxLength={254} value={email} onChange={event => setEmail(event.target.value)}/></Field><Field label='Initial password'><input type='password' autoComplete='new-password' required minLength={12} value={password} onChange={event => setPassword(event.target.value)}/></Field><label className='check-label'><input type='checkbox' checked={admin} onChange={event => setAdmin(event.target.checked)}/>Instance administrator</label>{error && <p className='connect-error' role='alert'>{error}</p>}<button className='primary-button' disabled={busy}>{busy ? 'Creating user…' : 'Create account'}</button></form>;
}

function UserDetails({ userId, operator, onChanged }: { userId: string; operator: AccountSession; onChanged: () => void }) {
  const [value, setValue] = useState<UserDetail | null>(null), [revision, setRevision] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [roomPages, setRoomPages] = useState<number[]>([]), [sessionPages, setSessionPages] = useState<number[]>([]);
  const [editing, setEditing] = useState(false), [action, setAction] = useState<Action | null>(null);
  useEffect(() => {
    let live = true; setBusy(true); setError('');
    const query = new URLSearchParams({ roomsFrom: String(roomPages.at(-1) || 0), sessionsFrom: String(sessionPages.at(-1) || 0) });
    void requestApi<UserDetail>('/admin/users/' + encodeURIComponent(userId) + '?' + query).then(result => { if (live) setValue(result); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [userId, roomPages, sessionPages, revision]);
  const refresh = () => { setRevision(previous => previous + 1); onChanged(); };
  if (!value) return <>{busy && <p role='status'>Loading user details…</p>}{error && <p className='connect-error' role='alert'>{error}<button className='secondary-button' onClick={() => setRevision(previous => previous + 1)}>Retry user details</button></p>}</>;
  const { user, security, storage } = value, protectedAccount = value.serviceAccount || userId === operator.userId, pendingDeletion = !!value.deactivation && ['pending', 'native_confirmed'].includes(value.deactivation.phase);
  return <><p><strong>{user.displayname || user.name}</strong> · {status(user, security)} · {user.admin ? 'Instance administrator' : 'User'}</p>
    {value.serviceAccount && <p>This service account is managed by the deployment.</p>}
    {error && <p className='connect-error' role='alert'>{error}</p>}{busy && <p role='status'>Refreshing user details…</p>}
    {value.deactivation && <p role='status'>Account deactivation: {value.deactivation.phase === 'native_confirmed' ? 'homeserver deactivated; local cleanup pending' : value.deactivation.phase}. Reference: {value.deactivation.id}.{['pending', 'native_confirmed'].includes(value.deactivation.phase) && ' Tavern access remains locked. The server will retry confirmation and local cleanup; if the native account is still active, use Deactivate account to complete the authorized request.'}</p>}<Tabs defaultValue='profile' className='settings-tabs'><TabsList aria-label='User administration sections'><TabsTrigger value='profile'>Profile</TabsTrigger><TabsTrigger value='security'>Security</TabsTrigger><TabsTrigger value='rooms'>Rooms</TabsTrigger><TabsTrigger value='sessions'>Sessions</TabsTrigger><TabsTrigger value='storage'>Storage</TabsTrigger><TabsTrigger value='audit'>Audit</TabsTrigger></TabsList>
      <TabsContent value='profile' className='product-section'><p>User ID: <code>{user.name}</code><br/>Created: {time(user.creation_ts)}<br/>Last seen: {time(user.last_seen_ts)}<br/>Email: {security.managed ? security.email || 'Not set' : 'Not managed by Tavern'}<br/>Email status: {emailStatus(security)}</p><button className='secondary-button' disabled={busy || value.serviceAccount} onClick={() => setEditing(true)}>Edit account</button></TabsContent>
      <TabsContent value='security' className='product-section'><p>Two-step verification: {mfaStatus(security)}<br/>Password change: {security.managed ? security.passwordChangeRequired ? 'Required before returning to Tavern' : 'Not required' : 'Not managed by Tavern'}<br/>Tavern access: {security.accessBlocked ? 'Blocked' : 'Allowed, subject to account status'}</p>{protectedAccount && <p>{value.serviceAccount ? 'Service account access changes require deployment maintenance.' : 'Use Account security to manage your own password, verification, and sessions.'}</p>}<div className='product-actions'>
        <button className='secondary-button' disabled={busy || protectedAccount || pendingDeletion || user.deactivated} onClick={() => setAction('require_password_change')}>Require password change…</button>
        <button className='secondary-button' disabled={busy || protectedAccount || pendingDeletion || status(user, security) !== 'Active' || !security.email || security.emailVerified} onClick={() => setAction('resend_verification')}>Resend email verification…</button>
        <button className='secondary-button' disabled={busy || protectedAccount || pendingDeletion || user.deactivated || !security.managed || !security.mfaMethods?.length} onClick={() => setAction('reset_mfa')}>Reset two-step verification…</button>
        <button className='secondary-button' disabled={busy || protectedAccount || pendingDeletion || user.deactivated} onClick={() => setAction('revoke_sessions')}>Revoke all sessions…</button>
        {user.deactivated || user.suspended || security.accessBlocked ? <button className='secondary-button' disabled={busy || protectedAccount || pendingDeletion} onClick={() => setAction('enable')}>Enable account…</button> : <button className='secondary-button danger-text' disabled={busy || protectedAccount || pendingDeletion} onClick={() => setAction('suspend')}>Suspend account…</button>}
        <button className='secondary-button danger-text' disabled={busy || protectedAccount || user.deactivated} onClick={() => setAction('deactivate')}>Deactivate account…</button>
      </div></TabsContent>
      <TabsContent value='rooms' className='product-section'><h3>Joined rooms ({value.rooms.total.toLocaleString()})</h3><p>Room membership is administrative metadata. Message contents are not available here.</p>{value.rooms.items.map(id => <p key={id}><code>{id}</code></p>)}{!value.rooms.items.length && <p>No joined rooms on this page.</p>}<div className='product-actions'><button className='secondary-button' disabled={busy || !roomPages.length} onClick={() => setRoomPages(previous => previous.slice(0, -1))}>Previous rooms</button><span>Page {roomPages.length + 1}</span><button className='secondary-button' disabled={busy || !hasNext(value.rooms.next)} onClick={() => setRoomPages(previous => [...previous, value.rooms.next!])}>Next rooms</button></div></TabsContent>
      <TabsContent value='sessions' className='product-section'><h3>Tavern sessions ({value.sessions.total.toLocaleString()})</h3><p>Only session metadata is shown. Revoking all sessions also signs out the user’s homeserver devices.</p>{value.sessions.items.map(device => <div className='device-row' key={device.id}><span><strong>{device.name || device.deviceId}</strong><small>Device: {device.deviceId}<br/>Created: {time(device.createdAt)}<br/>Last used: {time(device.lastSeen)}<br/>Expires: {time(device.expiresAt)}{device.ip && <><br/>IP address: {device.ip}</>}</small></span></div>)}{!value.sessions.items.length && <p>No active Tavern sessions on this page.</p>}<div className='product-actions'><button className='secondary-button' disabled={busy || !sessionPages.length} onClick={() => setSessionPages(previous => previous.slice(0, -1))}>Previous sessions</button><span>Page {sessionPages.length + 1}</span><button className='secondary-button' disabled={busy || !hasNext(value.sessions.next)} onClick={() => setSessionPages(previous => [...previous, value.sessions.next!])}>Next sessions</button><button className='secondary-button' disabled={busy || protectedAccount || pendingDeletion || user.deactivated} onClick={() => setAction('revoke_sessions')}>Revoke all sessions…</button></div></TabsContent>
      <TabsContent value='storage' className='product-section'><p>Recorded media usage: {storage.usageInitialized ? bytes(storage.usedBytes) : 'Unavailable until storage reconciliation'}<br/>Quota: {bytes(storage.quotaBytes) + (storage.quotaOverrideBytes === null ? ' (instance default)' : '')}<br/>Uncertain upload reservations: {storage.uncertainReservations.toLocaleString()}</p><p>Media usage includes encrypted uploads. Reconcile usage in the instance Storage section when the inventory is unavailable.</p><button className='secondary-button' disabled={busy || protectedAccount || pendingDeletion} onClick={() => setAction('set_quota')}>Set user quota…</button></TabsContent>
      <TabsContent value='audit' className='product-section'><h3>Recent account audit events</h3><p>The latest 20 matching events are shown. Use the instance Audit section for older events and filters.</p>{value.audit.map(event => <article className='product-section' key={event.id}><strong>{event.action}</strong><p>{time(event.created)}<br/>Actor: {event.actor}<br/>Target: {event.target}</p><p>{event.detail}</p></article>)}{!value.audit.length && <p>No recorded audit events for this account.</p>}</TabsContent>
    </Tabs>
    <Dialog open={editing} onOpenChange={setEditing}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Edit account</DialogTitle><DialogDescription>{userId}</DialogDescription></DialogHeader>{editing && <EditUser value={value} isSelf={userId === operator.userId} onSaved={() => { setEditing(false); refresh(); }}/>}</DialogContent></Dialog>
    <Dialog open={!!action} onOpenChange={open => { if (!open) setAction(null); }}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>{action && actionLabels[action]}</DialogTitle><DialogDescription>{userId}</DialogDescription></DialogHeader>{action && <UserAction key={action} action={action} value={value} onDone={() => { setAction(null); refresh(); }}/>}</DialogContent></Dialog>
  </>;
}

function EditUser({ value, isSelf, onSaved }: { value: UserDetail; isSelf: boolean; onSaved: () => void }) {
  const [name, setName] = useState(value.user.displayname || ''), [admin, setAdmin] = useState(!!value.user.admin), [locked, setLocked] = useState(!!value.user.locked), [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const accessChanged = admin !== !!value.user.admin || locked !== !!value.user.locked;
  return <form className='dialog-form' onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await requestApi('/admin/users/' + encodeURIComponent(value.user.name), { displayname: name, ...(admin !== !!value.user.admin ? { admin } : {}), ...(locked !== !!value.user.locked ? { locked } : {}), ...(accessChanged ? { confirmation } : {}) }, 'PUT'); toast.success('Account updated'); onSaved(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }}><Field label='Display name'><input maxLength={100} value={name} onChange={event => setName(event.target.value)}/></Field><label className='check-label'><input type='checkbox' checked={admin} disabled={isSelf} onChange={event => setAdmin(event.target.checked)}/>Instance administrator</label><label className='check-label'><input type='checkbox' checked={locked} disabled={isSelf || value.user.deactivated} onChange={event => setLocked(event.target.checked)}/>Lock account</label><p>Instance administrators can manage every account and instance settings. Locking limits account access according to the homeserver policy.</p>{accessChanged && <Field label={'Type ' + value.user.name + ' to confirm access changes'}><input required autoComplete='off' value={confirmation} onChange={event => setConfirmation(event.target.value)}/></Field>}{error && <p className='connect-error' role='alert'>{error}</p>}<button className='primary-button' disabled={busy || accessChanged && confirmation !== value.user.name}>{busy ? 'Saving account…' : 'Save account'}</button></form>;
}

const actionLabels: Record<Action, string> = { revoke_sessions: 'Revoke all sessions', reset_mfa: 'Reset two-step verification', require_password_change: 'Require password change', suspend: 'Suspend account', enable: 'Enable account', deactivate: 'Deactivate account', set_quota: 'Set user quota', resend_verification: 'Resend email verification' };
const actionDescriptions: Record<Action, string> = {
  resend_verification: 'Send a new verification code to the unverified email already on this account. The account owner must sign in and enter it in Account & security. This action cannot change the address or verify it for them.',
  revoke_sessions: 'Sign this user out of Tavern and their homeserver devices. Their next sign-in may require their encryption recovery key.',
  reset_mfa: 'Remove this user’s verification methods and recovery codes, revoke their sessions, and require a password change. Confirm the account owner’s identity before proceeding.',
  require_password_change: 'Require this user to change their password before returning to Tavern. Active sessions and devices will be revoked.',
  suspend: 'Block Tavern access and restrict homeserver writes. Existing message history is retained. You can enable the account again.',
  enable: 'Restore account access. A deactivated account needs a new initial password and cannot recover removed memberships or encryption devices through this action.',
  deactivate: 'Deactivate this account, revoke its sessions, and remove its memberships, account data, and encryption devices. Historical messages held by other users are retained.',
  set_quota: 'Set the maximum recorded media storage for this user. Reducing the limit below their usage blocks further uploads without deleting existing files.',
};
function UserAction({ action, value, onDone }: { action: Action; value: UserDetail; onDone: () => void }) {
  const [security, setSecurity] = useState<{ totpEnabled: boolean; emailMfaEnabled: boolean } | null>(null), [revision, setRevision] = useState(0);
  const [confirmation, setConfirmation] = useState(''), [password, setPassword] = useState(''), [code, setCode] = useState(''), [method, setMethod] = useState('totp'), [challengeId, setChallengeId] = useState('');
  const [newPassword, setNewPassword] = useState(''), [repeatPassword, setRepeatPassword] = useState('');
  const [defaultQuota, setDefaultQuota] = useState(value.storage.quotaOverrideBytes === null), [quota, setQuota] = useState(value.storage.quotaBytes === null ? '' : String(value.storage.quotaBytes / 1048576));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let live = true; setError('');
    void requestApi('/account/security').then(result => { if (live) { setSecurity(result); setMethod(result.totpEnabled ? 'totp' : result.emailMfaEnabled ? 'email' : 'totp'); } }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [revision]);
  const needsMfa = security?.totpEnabled || security?.emailMfaEnabled;
  const needsPassword = action === 'enable' && value.user.deactivated;
  return <form className='dialog-form' onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (needsPassword && newPassword !== repeatPassword) throw new Error('The new passwords do not match.');
      const quotaBytes = defaultQuota ? null : Math.round(Number(quota) * 1048576);
      if (action === 'set_quota' && !defaultQuota && (!quota.trim() || !Number.isSafeInteger(quotaBytes) || quotaBytes! < 1024)) throw new Error('Enter a storage quota of at least 1024 bytes.');
      const result = await requestApi('/admin/users/' + encodeURIComponent(value.user.name) + '/actions', { action, confirmation, password, ...(needsMfa ? { method, code, challengeId } : {}), ...(action === 'set_quota' ? { quotaBytes } : {}), ...(needsPassword ? { newPassword } : {}) });
      setPassword(''); setCode(''); setNewPassword(''); setRepeatPassword('');
      if (result.ok === false) toast.message(result.message || 'The operation is still pending. Review the account status.');
      else toast.success(actionLabels[action] + ' completed');
      onDone();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }}><p>{actionDescriptions[action]}</p>{action === 'resend_verification' && <p>Recipient: {value.security.email}</p>}
    {action === 'set_quota' && <><label className='check-label'><input type='checkbox' checked={defaultQuota} onChange={event => setDefaultQuota(event.target.checked)}/>Use instance default quota</label>{!defaultQuota && <Field label='User quota (MiB)'><input type='number' required min={0.0009765625} step='any' value={quota} onChange={event => setQuota(event.target.value)}/></Field>}</>}
    {needsPassword && <><Field label='New initial password'><input type='password' autoComplete='new-password' minLength={12} required value={newPassword} onChange={event => setNewPassword(event.target.value)}/></Field><Field label='Confirm new initial password'><input type='password' autoComplete='new-password' minLength={12} required value={repeatPassword} onChange={event => setRepeatPassword(event.target.value)}/></Field></>}
    <Field label={'Type ' + value.user.name + ' to confirm'}><input required autoComplete='off' value={confirmation} onChange={event => setConfirmation(event.target.value)}/></Field>
    <Field label='Your administrator password'><input type='password' autoComplete='current-password' required value={password} onChange={event => setPassword(event.target.value)}/></Field>
    {!security && <><p role='status'>Loading your verification methods…</p>{error && <button type='button' className='secondary-button' onClick={() => setRevision(previous => previous + 1)}>Retry verification methods</button>}</>}
    {needsMfa && <><Field label='Administrator verification method'><select value={method} onChange={event => { setMethod(event.target.value); setCode(''); }}>{security!.totpEnabled && <option value='totp'>Authenticator app</option>}{security!.emailMfaEnabled && <option value='email'>Email</option>}<option value='recovery'>Recovery code</option></select></Field>{method === 'email' && <button type='button' className='secondary-button' disabled={busy || !password} onClick={async () => { setBusy(true); setError(''); try { const result = await requestApi('/account/security/email-code', { password }); setChallengeId(result.challengeId); toast.success('Administrator verification code sent'); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>Send administrator email code</button>}<Field label='Administrator verification code'><input autoComplete='one-time-code' required value={code} onChange={event => setCode(event.target.value)}/></Field></>}
    {error && <p className='connect-error' role='alert'>{error}</p>}<button className={'primary-button ' + (action === 'deactivate' ? 'delete-confirm' : '')} disabled={busy || !security || confirmation !== value.user.name || !password || !!needsMfa && (!code || method === 'email' && !challengeId)}>{busy ? 'Applying change…' : actionLabels[action]}</button>
  </form>;
}
