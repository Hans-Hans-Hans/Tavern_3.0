import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { accountArtworkOwner, requestApi } from '@/lib/api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InvitationSplash } from './invitation-splash';

export function RedeemInvite({ onJoined }: { onJoined: (roomId: string) => void }) {
  const [token, setToken] = useState(() => new URLSearchParams(location.search).get('invite') || '');
  const [preview, setPreview] = useState<any>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const owner = accountArtworkOwner();
  useEffect(() => {
    let live = true; setPreview(null);
    if (token) requestApi('/invitations/preview/' + encodeURIComponent(token)).then(value => { if (live && accountArtworkOwner() === owner) setPreview(value); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [token, owner]);
  function close() { setToken(''); setPreview(null); const url = new URL(location.href); url.searchParams.delete('invite'); history.replaceState(null, '', url); }
  return <Dialog open={!!token} onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Join {preview?.roomName || 'a conversation'}</DialogTitle><DialogDescription>{preview?.requiresEmail ? 'This invitation requires a verified email matching its restrictions.' : 'Accept this invitation to join the conversation.'}</DialogDescription></DialogHeader>{preview?.splashMxc && <InvitationSplash mxc={preview.splashMxc}/>} {error && <p className='connect-error' role='alert'>{error}</p>}<button className='primary-button' disabled={busy || !preview} onClick={async () => {
    setBusy(true); setError('');
    try {
      if (accountArtworkOwner() !== owner) throw new Error('Your account changed. Reopen this invitation.');
      const result = await requestApi('/invitations/redeem', { token });
      if (accountArtworkOwner() !== owner) return;
      close(); onJoined(result.roomId); toast.success('Invitation accepted');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }}>{busy ? 'Joining…' : 'Accept invitation'}</button></DialogContent></Dialog>;
}
