import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { accountArtworkOwner, requestApi } from '@/lib/api';
import { clearInvitationUrl, invitationToken } from '@/lib/invitation-link';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InvitationSplash } from './invitation-splash';

export function RedeemInvite({ onJoined }: { onJoined: (roomId: string) => void }) {
  const [, redraw] = useState(0), token = invitationToken(location), account = accountArtworkOwner();
  const scope = useRef({ token, account, version: 0 });
  if (scope.current.token !== token || scope.current.account !== account) scope.current = { token, account, version: scope.current.version + 1 };
  useEffect(() => {
    const changed = () => redraw(value => value + 1);
    window.addEventListener('popstate', changed); window.addEventListener('tavern:signout', changed);
    return () => { window.removeEventListener('popstate', changed); window.removeEventListener('tavern:signout', changed); };
  }, []);
  return token ? <InvitationAcceptance key={scope.current.version} token={token} onJoined={onJoined} onClosed={() => redraw(value => value + 1)}/> : null;
}
function InvitationAcceptance({ token, onJoined, onClosed }: { token: string; onJoined: (roomId: string) => void; onClosed: () => void }) {
  const [preview, setPreview] = useState<any>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const owner = useRef(accountArtworkOwner()).current, live = useRef(false), pending = useRef(false), previewVersion = useRef(0);
  const current = () => live.current && accountArtworkOwner() === owner && invitationToken(location) === token;
  useEffect(() => {
    live.current = true; const version = ++previewVersion.current;
    void requestApi('/invitations/preview/' + encodeURIComponent(token)).then(value => { if (current() && version === previewVersion.current) setPreview(value); }).catch(failure => { if (current() && version === previewVersion.current) setError(failure.message); });
    return () => { live.current = false; previewVersion.current++; };
  }, [token, owner]);
  function close() {
    if (!current()) return;
    history.replaceState(null, '', clearInvitationUrl(location.href)); onClosed();
  }
  if (accountArtworkOwner() !== owner || invitationToken(location) !== token) return null;
  return <Dialog open onOpenChange={open => { if (!open && !pending.current) close(); }}><DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>Join {preview?.roomName || 'a conversation'}</DialogTitle><DialogDescription>{preview?.requiresEmail ? 'This invitation requires a verified email matching its restrictions.' : 'Accept this invitation to join the conversation.'}</DialogDescription></DialogHeader>{preview?.splashMxc && <InvitationSplash mxc={preview.splashMxc}/>} {error && <p className="connect-error" role="alert">{error}</p>}<button className="primary-button" disabled={busy || !preview} onClick={async () => {
    if (!current() || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await requestApi('/invitations/redeem', { token });
      if (!current()) return;
      close(); onJoined(result.roomId); toast.success('Invitation accepted');
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) { pending.current = false; setBusy(false); } }
  }}>{busy ? 'Joining...' : 'Accept invitation'}</button></DialogContent></Dialog>;
}
