import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { canEditThreadPolicy, enableThreadSettings, isThreadModerator, readThreadPolicy, saveThreadPolicy, threadArchiveIntervals, threadPolicyEvent, threadReplyRestriction } from '@/lib/thread-policy';

export function ThreadSettings({ roomId, rootId, authorId, enabled, onChanged }: { roomId: string; rootId: string; authorId?: string; enabled: boolean; onChanged?: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false), [value, setValue] = useState(() => readThreadPolicy(roomId, rootId)), [tags, setTags] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [reopen, setReopen] = useState(false), [, refresh] = useState(0);
  useEffect(() => onMatrixUpdate(() => refresh(value => value + 1)), []);
  useEffect(() => { const next = readThreadPolicy(roomId, rootId); setValue(next); setTags(next.tags.join(', ')); setError(''); setReopen(false); }, [roomId, rootId, open]);
  if (!enabled || !canEditThreadPolicy(roomId, rootId, authorId)) return null;
  const moderator = isThreadModerator(roomId), restriction = threadReplyRestriction(roomId, rootId);
  async function save() { setBusy(true); setError(''); try { await saveThreadPolicy(roomId, rootId, { ...value, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean) }, reopen); setOpen(false); await onChanged?.(); toast.success('Thread settings saved'); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <><button className='secondary-button' onClick={() => setOpen(true)}>Thread settings</button><Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}><DialogContent><DialogHeader><DialogTitle>Thread settings</DialogTitle><DialogDescription>Manage this discussion without removing its messages. Thread titles, tags and restrictions are room metadata visible to the homeserver.</DialogDescription></DialogHeader><form className='dialog-form' onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy}>
    <label>Title<input value={value.title} maxLength={120} onChange={e => setValue({ ...value, title: e.target.value })}/></label><label>Tags, separated by commas<input value={tags} maxLength={338} onChange={e => setTags(e.target.value)}/></label>
    <label className='check-label'><input type='checkbox' checked={value.closed} onChange={e => setValue({ ...value, closed: e.target.checked })}/>Close replies</label><label className='check-label'><input type='checkbox' checked={value.archived} onChange={e => setValue({ ...value, archived: e.target.checked })}/>Archive thread</label>
    {moderator && <label className='check-label'><input type='checkbox' checked={value.locked} onChange={e => setValue({ ...value, locked: e.target.checked })}/>Lock this thread (moderators can unlock)</label>}
    <label>Archive after inactivity<select value={value.autoArchiveSeconds} onChange={e => setValue({ ...value, autoArchiveSeconds: Number(e.target.value) })}>{threadArchiveIntervals.map(seconds => <option key={seconds} value={seconds}>{seconds === 0 ? 'Off' : seconds === 3600 ? '1 hour' : `${seconds / 86400} day${seconds === 86400 ? '' : 's'}`}</option>)}</select></label>
    {restriction && !value.locked && <label className='check-label'><input type='checkbox' checked={reopen} onChange={e => { setReopen(e.target.checked); if (e.target.checked) setValue({ ...value, closed: false, archived: false }); }}/>Reopen and restart the inactivity timer</label>}
    <p className='login-help'>Closing, locking or archiving stops thread replies until reopened. History remains readable.</p><div className='inline-actions'><button className='primary-button'>Save thread settings</button><button type='button' className='secondary-button' onClick={() => setOpen(false)}>Cancel</button></div></fieldset>{error && <p role='alert' className='connect-error'>{error}</p>}</form></DialogContent></Dialog></>;
}

export function EnableThreadSettings({ roomId, enabled }: { roomId: string; enabled: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const client = getMatrixClient(), room = client?.getRoom(roomId), me = client?.getUserId();
  if (!enabled || !room || !me || !room.currentState.maySendStateEvent('m.room.power_levels', me) || room.currentState.getStateEvents('m.room.power_levels', '')?.getContent().events?.[threadPolicyEvent] === 0) return null;
  return <section className='settings-section'><h3>Member thread settings</h3><p>Allow thread authors to edit titles and tags, close discussions and set inactivity archiving. Moderator locks remain protected by the server.</p><button className='secondary-button' disabled={busy} onClick={() => { setBusy(true); setError(''); void enableThreadSettings(roomId).then(() => toast.success('Member thread settings enabled')).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>Enable member thread settings</button>{error && <p role='alert'>{error}</p>}</section>;
}
