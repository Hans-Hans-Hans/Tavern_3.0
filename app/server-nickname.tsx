import { useEffect, useState } from 'react';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { canManageServerNickname, loadServerNickname, readServerNickname, saveServerNickname, type ServerNickname } from '@/lib/server-nickname';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const eventName = 'tavern:server-nickname';
export function openServerNickname(serverId: string, userId: string) { window.dispatchEvent(new CustomEvent(eventName, { detail: { serverId, userId } })); }
export function ServerNicknameDialog({ onChanged }: { onChanged?: () => Promise<unknown> }) {
  const [target, setTarget] = useState<{ serverId: string; userId: string } | null>(null);
  useEffect(() => {
    const show = (event: Event) => { const detail = (event as CustomEvent).detail; if (typeof detail?.serverId === 'string' && typeof detail?.userId === 'string' && canManageServerNickname(detail.serverId, detail.userId)) setTarget({ serverId: detail.serverId, userId: detail.userId }); };
    window.addEventListener(eventName, show); return () => window.removeEventListener(eventName, show);
  }, []);
  return <Dialog open={!!target} onOpenChange={open => { if (!open) setTarget(null); }}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Manage server nickname</DialogTitle><DialogDescription>Choose how this member’s name appears in this server.</DialogDescription></DialogHeader>{target && <ServerNicknameEditor key={target.serverId + target.userId} {...target} onChanged={onChanged}/>}</DialogContent></Dialog>;
}
export function ServerNicknameEditor({ serverId, userId, onChanged }: { serverId: string; userId: string; onChanged?: () => Promise<unknown> }) {
  const [current, setCurrent] = useState<ServerNickname>(() => readServerNickname(serverId, userId));
  const [name, setName] = useState(current.name || ''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [, redraw] = useState(0); useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  if (!canManageServerNickname(serverId, userId)) return <p>You can manage nicknames only for current server members below your authority.</p>;
  const save = async (value: string | null) => {
    setBusy(true); setError(''); setStatus('');
    try {
      const saved = await saveServerNickname(serverId, userId, value, current.eventId);
      setCurrent(saved); setName(saved.name || ''); setStatus(saved.name ? 'Server nickname saved.' : 'The member’s chosen name is restored.');
      try { await onChanged?.(); } catch { setError('The nickname was saved, but the conversation could not refresh. Reopen it to see the change.'); }
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <form className='dialog-form' onSubmit={event => { event.preventDefault(); void save(name); }}>
    <p>This name applies to {getMatrixClient()?.getRoom(serverId)?.name || 'this server'} and its linked channels. The member’s Matrix account, avatar and own profile stay visible and unchanged.</p>
    <fieldset disabled={busy}>
      <label>Matrix account<input readOnly value={userId}/></label>
      <label>Server nickname<input maxLength={60} value={name} onChange={event => setName(event.target.value)}/></label>
      <p className='login-help'>Server members and the homeserver can read this nickname and who changed it. Removing the override restores the member’s chosen server or global name.</p>
      <div className='product-actions'>
        <button className='primary-button' disabled={!name.trim()}>{busy ? 'Saving…' : 'Save server nickname'}</button>
        <button type='button' className='secondary-button' disabled={current.name === null} onClick={() => void save(null)}>Use member’s chosen name</button>
        <button type='button' className='secondary-button' onClick={async () => { setBusy(true); setError(''); setStatus(''); try { const fresh = await loadServerNickname(serverId, userId); setCurrent(fresh); setName(fresh.name || ''); setStatus('Current nickname loaded.'); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }}>Reload current nickname</button>
      </div>
    </fieldset>
    {status && <p role='status'>{status}</p>}{error && <p role='alert' className='connect-error'>{error}</p>}
  </form>;
}
export function ServerNicknameNotice({ serverId, userId }: { serverId: string; userId: string }) {
  const [, redraw] = useState(0); useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  const current = readServerNickname(serverId, userId);
  return current.name ? <p className='login-help'>A server moderator set your visible nickname to “{current.name}”. Your own profile remains saved; editing it does not remove that server nickname.</p> : null;
}
