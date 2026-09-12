import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { Copy, MessageCircle, RefreshCw, Search, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { contactPeer, observeContacts, setUserBlocked, socialApi, type SocialState } from '@/lib/social';
import './community.css';
import './friends.css';
import { CommunityImage } from './community-settings';
import { ConversationInvitationPrivacy } from './invitation-privacy';
import { ServerInvitationPrivacy } from './server-invitation-privacy';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
export function SocialPanel({ onMessage }: { onMessage: (userId: string) => void }) {
  const [, redraw] = useState(0), client = getMatrixClient(), actor = client?.getUserId(), generation = accountArtworkOwner();
  const scope = useRef({ client, actor, generation, key: 0 });
  if (scope.current.client !== client || scope.current.actor !== actor || scope.current.generation !== generation) scope.current = { client, actor, generation, key: scope.current.key + 1 };
  useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  return <SocialPanelForOwner key={scope.current.key} onMessage={onMessage} onStale={() => redraw(value => value + 1)}/>;
}
function SocialPanelForOwner({ onMessage, onStale }: { onMessage: (userId: string) => void; onStale: () => void }) {
  const owner = useRef({ client: getMatrixClient(), actor: getMatrixClient()?.getUserId(), generation: accountArtworkOwner() }).current;
  const alive = useRef(true), reading = useRef(0), writing = useRef(false), reloadAfterWrite = useRef(false), dataRef = useRef<SocialState | null>(null);
  const current = useCallback(() => alive.current && getMatrixClient() === owner.client && owner.client?.getUserId() === owner.actor && accountArtworkOwner() === owner.generation, [owner]);
  const [data, setData] = useState<SocialState | null>(null), [tab, setTab] = useState('all'), [search, setSearch] = useState(''), [target, setTarget] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState<{ user: string; action: 'remove' | 'block' } | null>(null), [, redraw] = useState(0);
  const [server, setServer] = useState(''), [notice, setNotice] = useState(''), [replaceCode, setReplaceCode] = useState<string | null>(null);
  const me = owner.actor || '';
  const codeId = useId();
  const applyData = useCallback((value: SocialState) => { if (!current()) return; dataRef.current = value; setData(value); setConfirm(previous => previous && value.requests.some(request => request.status === 'accepted' && contactPeer(request, owner.actor || '') === previous.user) ? previous : null); }, [current, owner]);
  const refresh = useCallback(async (clearError = false) => {
    if (!current()) return; if (writing.current) { reloadAfterWrite.current = true; return; } const revision = ++reading.current;
    try { const value = await socialApi(); if (current() && revision === reading.current) { applyData(value); if (clearError) setError(''); } }
    catch (failure) { if (current() && revision === reading.current) setError((failure as Error).message); }
  }, [current, applyData]);
  useEffect(() => { alive.current = true; void refresh(); const stop = observeContacts(() => void refresh()), off = onMatrixUpdate(() => redraw(v => v + 1)); return () => { alive.current = false; reading.current++; stop(); off(); }; }, [refresh]);
  async function run(fn: () => Promise<SocialState>) {
    if (!current() || writing.current) return false; writing.current = true; reading.current++; setBusy(true); setError(''); setNotice('');
    try { const value = await fn(); if (!current()) return false; applyData(value); return true; }
    catch (failure) { if (current()) { setError((failure as Error).message); setConfirm(null); } return false; }
    finally { writing.current = false; if (current()) { setBusy(false); if (reloadAfterWrite.current) { reloadAfterWrite.current = false; void refresh(); } } }
  }
  function capture(event: SyntheticEvent) { if (!current()) { event.preventDefault(); event.stopPropagation(); onStale(); } }
  const contacts = data?.requests.filter(r => r.status === 'accepted').map(r => ({ ...r, peer: contactPeer(r, me) })) || [], pending = data?.requests.filter(r => r.status === 'pending') || [];
  const name = (user: string) => getMatrixClient()?.getUser(user)?.displayName || user.split(':')[0].replace(/^@/, '');
  const matches = (user: string) => (user + ' ' + name(user)).toLowerCase().includes(search.toLowerCase());
  const shownContacts = contacts.filter(r => matches(r.peer) && (tab !== 'online' || owner.client?.getUser(r.peer)?.presence === 'online'));
  const incoming = pending.filter(r => r.target === me), outgoing = pending.filter(r => r.sender === me);
  async function sendRequest() {
    const draft = target.trim(), destination = server.trim();
    if (await run(() => socialApi('/requests', 'POST', { target: draft, ...(destination ? { server: destination } : {}) })) && current()) {
      setTarget(value => value.trim() === draft ? '' : value);
      setNotice('Friend request sent. Your friend can accept it in Pending.');
    }
  }
  async function copyCode() {
    const code = dataRef.current?.friendCode;
    if (!current() || !code) return;
    try { await navigator.clipboard.writeText(code); if (current() && dataRef.current?.friendCode === code) { setError(''); setNotice('Friend code copied.'); } }
    catch { if (current()) setError('Copy was unavailable. Select your friend code and copy it manually.'); }
  }
  function requestList(rows: typeof pending, title: string) {
    const shown = rows.filter(r => matches(contactPeer(r, me)));
    return <section className='friends-request-group' aria-label={title}><h3>{title} <span>{rows.length}</span></h3>
      {shown.map(r => { const peer = contactPeer(r, me); return <div className='social-contact-row' key={r.id}>
        <div className='friends-avatar'><CommunityImage mxc={owner.client?.getUser(peer)?.avatarUrl || ''} name={name(peer)} size={40}/></div>
        <span><strong>{name(peer)}</strong><small>{peer}</small></span>
        <div className='friends-row-actions'>{r.target === me ? <><button className='primary-button' disabled={busy} onClick={() => void run(() => socialApi('/requests/' + r.id, 'PATCH', { operation: 'accept' }))}>Accept</button><button className='secondary-button' disabled={busy} onClick={() => void run(() => socialApi('/requests/' + r.id, 'PATCH', { operation: 'reject' }))}>Decline</button></> : <button className='secondary-button' disabled={busy} onClick={() => void run(() => socialApi('/requests/' + r.id, 'PATCH', { operation: 'cancel' }))}>Cancel request</button>}</div>
      </div>; })}
      {!shown.length && <p className='friends-empty'>{search ? 'No requests match your search.' : title === 'Received' ? 'You’re all caught up. New friend requests appear here.' : 'No requests waiting for a reply.'}</p>}
    </section>;
  }
  return <section className='social-panel friends-panel' onClickCapture={capture} onSubmitCapture={capture}>
    <div className='friends-heading'><div><h2><Users size={24}/>Friends</h2><p>Your people, one code away.</p></div><button type='button' className='icon-button' aria-label='Refresh contacts' disabled={busy} onClick={() => void refresh(true)}><RefreshCw size={18}/></button></div>
    <div className='work-tabs' aria-label='Friends views'>{[['all', `All (${contacts.length})`], ['online', 'Online'], ['pending', `Pending (${pending.length})`], ['blocked', 'Blocked'], ['privacy', 'Privacy']].map(([value, label]) => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}</div>
    {error && <p role='alert' className='connect-error'>{error}</p>}{notice && <p role='status' className='friends-notice'>{notice}</p>}
    {!data && !error && <p role='status'>Loading friends…</p>}
    {['all', 'online'].includes(tab) && <div className='friends-connect-grid'>
      <section className='friend-code-card' aria-label='Your friend code'><ShieldCheck size={22}/><h3>Your friend code</h3><p>Share this code to receive a friend request. You decide who to accept.</p>
        {data?.friendCode ? <><label className='sr-only' htmlFor={codeId}>Your friend code</label><input id={codeId} className='friend-code-value' readOnly value={data.friendCode} onFocus={e => e.currentTarget.select()}/><div className='friends-code-actions'><button className='secondary-button' type='button' onClick={() => void copyCode()}><Copy size={16}/>Copy code</button><button className='friends-text-button' type='button' disabled={busy} onClick={() => setReplaceCode(data.friendCode!)}>Replace code</button></div></> : <p>{data ? 'Your code is unavailable. Refresh to try again.' : 'Loading your code…'}</p>}
      </section>
      <form className='dialog-form friend-request-form' onSubmit={e => { e.preventDefault(); void sendRequest(); }}><h3>Add a friend</h3><p>Paste their friend code. A full account address also works.</p><label>Friend code<input required value={target} onChange={e => setTarget(e.target.value)} placeholder='TAV-XXXX-XXXX-XXXX' maxLength={255} autoComplete='off' spellCheck={false}/></label>
        <details><summary>Specify a server <span className='optional'>optional</span></summary><label>Server address<input value={server} onChange={e => setServer(e.target.value)} placeholder={me.split(':').slice(1).join(':')} maxLength={255} autoComplete='off' spellCheck={false}/></label><p className='login-help'>Leave blank to use this Tavern. Cross-instance friendships are not enabled.</p></details>
        <button className='primary-button' disabled={busy || !target.trim() || !data}><UserPlus size={16}/>{busy ? 'Sending…' : 'Send request'}</button>
      </form>
    </div>}
    {tab !== 'privacy' && <label className='community-contact-search'><Search size={18}/><input type='search' aria-label='Find a contact' placeholder='Search friends and requests' value={search} onChange={e => setSearch(e.target.value)}/></label>}
    {['all', 'online'].includes(tab) && <section aria-label='Friend list'><h3 className='friends-list-title'>{tab === 'online' ? 'Online friends' : 'Your friends'} <span>{shownContacts.length}</span></h3>
      {shownContacts.map(r => <div className='social-contact-row' key={r.id}><div className='friends-avatar'><CommunityImage mxc={owner.client?.getUser(r.peer)?.avatarUrl || ''} name={name(r.peer)} size={40}/></div><span><strong>{name(r.peer)}</strong><small>{r.peer}</small></span><div className='friends-row-actions'><button className='icon-button' title='Message' aria-label={'Message ' + name(r.peer)} onClick={() => { if (current()) onMessage(r.peer); }}><MessageCircle size={18}/></button><button className='secondary-button' disabled={busy} onClick={() => setConfirm({ user: r.peer, action: 'remove' })}>Remove</button><button className='secondary-button' disabled={busy} onClick={() => setConfirm({ user: r.peer, action: 'block' })}>Block</button></div></div>)}
      {!shownContacts.length && <p className='friends-empty'>{search ? 'No friends match your search.' : tab === 'online' ? 'No friends are showing as online right now.' : 'Send a request to add your first contact. Recipients choose whether to accept.'}</p>}
    </section>}
    {tab === 'pending' && <>{requestList(incoming, 'Received')}{requestList(outgoing, 'Sent')}</>}
    {tab === 'blocked' && <section aria-label='Blocked friends'>{data?.blocked.filter(matches).map(user => <div className='social-contact-row' key={user}><span><strong>{name(user)}</strong><small>{user}</small></span><button disabled={busy} className='secondary-button' onClick={() => void run(() => setUserBlocked(user, false))}>Unblock</button></div>)}{!data?.blocked.filter(matches).length && <p className='friends-empty'>{search ? 'No blocked accounts match your search.' : 'No blocked users.'}</p>}<p className='login-help'>Blocking removes friends and pending requests, ignores that user in your Matrix account, and prevents their new room invitations. Shared room membership is unchanged.</p></section>}
    {tab === 'privacy' && <><ConversationInvitationPrivacy/><ServerInvitationPrivacy/>{data && <form className='dialog-form'><label>Who can send friend requests?<select value={data.privacy} disabled={busy} onChange={e => void run(() => socialApi('/privacy', 'PUT', { requests: e.target.value }))}><option value='everyone'>Anyone on this instance</option><option value='shared_server'>People in a shared server</option><option value='nobody'>Nobody</option></select></label><p className='login-help'>These settings also apply to friend codes. They do not change existing private room memberships.</p></form>}</>}
    {data?.hasMore && <p className='login-help'>Showing the latest 500 friends and requests.</p>}
    <AlertDialog open={!!confirm} onOpenChange={open => { if (!open && !busy) setConfirm(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirm?.action === 'block' ? 'Block' : 'Remove'} {confirm ? name(confirm.user) : 'friend'}?</AlertDialogTitle><AlertDialogDescription>{confirm?.action === 'block' ? 'Their friend requests will be blocked and their messages will be ignored. Existing shared rooms and message history remain.' : 'This removes the friendship for both of you. Message history remains.'}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={e => { e.preventDefault(); if (!confirm || !current()) return; if (!dataRef.current?.requests.some(request => request.status === 'accepted' && contactPeer(request, me) === confirm.user)) { setConfirm(null); return; } void run(() => confirm.action === 'block' ? setUserBlocked(confirm.user, true) : socialApi('/contacts/' + encodeURIComponent(confirm.user), 'DELETE')).then(saved => { if (saved && current()) setConfirm(null); }); }}>Confirm</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={!!replaceCode} onOpenChange={open => { if (!open && !busy) setReplaceCode(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Replace your friend code?</AlertDialogTitle><AlertDialogDescription>Your old code will stop accepting new requests. Your friends and existing requests stay as they are.</AlertDialogDescription></AlertDialogHeader>{error && <p role='alert' className='connect-error'>{error}</p>}<AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep current code</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={e => { e.preventDefault(); if (!replaceCode || !current()) return; void run(() => socialApi('/friend-code', 'POST', { previousCode: replaceCode })).then(saved => { if (saved && current()) { setReplaceCode(null); setNotice('Your friend code was replaced. Share the new code with your friends.'); } }); }}>Replace friend code</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
