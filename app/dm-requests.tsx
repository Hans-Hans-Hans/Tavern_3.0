import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { acceptDmRequest, blockDmRequest, declineDmRequest, dmRequests, type DmRequest, type DmRequestResult } from '@/lib/dm-requests';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

export function DmRequests({ onOpen }: { onOpen: (roomId: string) => void | Promise<void> }) {
  const [, redraw] = useState(0), client = getMatrixClient(), account = accountArtworkOwner();
  const scope = useRef({ client, account, generation: 0 });
  if (scope.current.client !== client || scope.current.account !== account) scope.current = { client, account, generation: scope.current.generation + 1 };
  useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  return <Inbox key={scope.current.generation} onOpen={onOpen}/>;
}
function Inbox({ onOpen }: { onOpen: (roomId: string) => void | Promise<void> }) {
  const owner = useRef({ client: getMatrixClient(), account: accountArtworkOwner() }).current, alive = useRef(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(0), [confirm, setConfirm] = useState<DmRequest | null>(null), [, redraw] = useState(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && getMatrixClient() === owner.client && accountArtworkOwner() === owner.account;
  const all = dmRequests(), rows = all.filter(row => (row.name + ' ' + row.inviter + ' ' + row.roomId).toLocaleLowerCase().includes(query.toLocaleLowerCase())), lastPage = Math.max(0, Math.ceil(rows.length / 25) - 1), shownPage = Math.min(page, lastPage);
  async function run(request: DmRequest, action: (request: DmRequest) => Promise<DmRequestResult>) {
    if (!current() || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await action(request); if (!current()) return;
      setConfirm(null); redraw(value => value + 1);
      if (result.status === 'partial') setError(result.message);
      else { setNotice(result.message); if (result.status === 'accepted') await onOpen(result.roomId); }
    } catch (failure) { if (current()) { setConfirm(null); setError((failure as Error).message); } }
    finally { if (current()) setBusy(false); }
  }
  return <section className='dialog-form' aria-label='Message request inbox'>
    <p className='login-help'>These are room invitations marked as direct messages by their senders. Accepting joins the room and adds it to Messages. The marker does not prove who else can read the room or make its sender a trusted contact.</p>
    <p className='login-help'>No messages, attachments or profile images are loaded by this inbox before acceptance. Contacts requests are managed separately in Friends.</p>
    <label>Find a message request<input type='search' value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder='Name, Matrix ID or room ID'/></label>
    {error && <p role='alert' className='connect-error'>{error}</p>}{notice && <p role='status'>{notice}</p>}
    {!owner.client && <p>Connect your Matrix account to view message requests.</p>}
    {!all.length && owner.client && <p>No message requests.</p>}{all.length > 0 && !rows.length && <p>No matching message requests.</p>}
    <div className='dialog-member-list'>{rows.slice(shownPage * 25, shownPage * 25 + 25).map(request => <article key={request.roomId} className='dialog-form' aria-label={'Message request from ' + request.inviter}>
      <strong>{request.name}</strong><span>Invited by {request.inviter}</span><small>{request.roomId}</small>
      <p className='login-help'>{request.encrypted ? 'The current room state enables encryption.' : 'Encryption is not confirmed in the available room state.'} {request.publicRoom ? 'This room allows public joins.' : 'The invitation may be for a group; other room members may be present.'}</p>
      {request.blocked && <p>This user is blocked. You can decline this invitation or manage blocks in Contacts.</p>}
      {request.joined && <p>You joined this room. Finish adding it to your Messages list; this does not join again.</p>}
      <div className='inline-actions'><button type='button' className='primary-button' disabled={busy || request.blocked} onClick={() => void run(request, acceptDmRequest)}>{request.joined ? 'Retry adding to Messages' : 'Accept message request'}</button>
      {!request.joined && <><button type='button' className='secondary-button' disabled={busy} onClick={() => void run(request, declineDmRequest)}>Decline</button><button type='button' className='secondary-button' disabled={busy || request.blocked} onClick={() => setConfirm(request)}>Block sender</button></>}</div>
    </article>)}</div>
    {rows.length > 25 && <div className='inline-actions'><button type='button' disabled={shownPage === 0 || busy} onClick={() => setPage(shownPage - 1)}>Previous requests</button><span>Page {shownPage + 1} of {lastPage + 1}</span><button type='button' disabled={shownPage === lastPage || busy} onClick={() => setPage(shownPage + 1)}>Next requests</button></div>}
    <AlertDialog open={!!confirm} onOpenChange={open => { if (!open && !busy) setConfirm(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Block this sender?</AlertDialogTitle><AlertDialogDescription>Block {confirm?.inviter} and decline this invitation. Their new invitations and contact requests are blocked, and their messages are ignored. Existing shared room memberships and history remain.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); if (confirm) void run(confirm, blockDmRequest); }}>Block and decline</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
