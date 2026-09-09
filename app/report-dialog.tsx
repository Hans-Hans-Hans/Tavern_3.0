import { useEffect, useRef, useState } from 'react';
import { requestApi } from '@/lib/api';
import { roomContext } from '@/lib/channel-policy';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export type ReportTarget = { kind: 'message' | 'user' | 'file' | 'server'; roomId?: string; eventId?: string; targetId?: string };
function managedRoom(roomId?: string) {
  try { const context = roomId && roomContext(roomId); return !!context && !context.unknownPolicy && context.policies.length > 0; } catch { return false; }
}
export function ReportDialog({ target, onClose }: { target: ReportTarget | null; onClose: () => void }) {
  const [reason, setReason] = useState(''), [evidence, setEvidence] = useState(''), [audience, setAudience] = useState<'platform' | 'room'>('platform');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const key = JSON.stringify(target), current = useRef(key); current.current = key;
  useEffect(() => { setAudience('platform'); setReason(''); setEvidence(''); setError(''); }, [key]);
  const shareable = managedRoom(target?.roomId), selectedAudience = shareable ? audience : 'platform';
  return <Dialog open={!!target} onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Report {target?.kind}</DialogTitle><DialogDescription>Only the text you enter and the referenced IDs are submitted. Encrypted message contents are not automatically included.</DialogDescription></DialogHeader>
    <form className='dialog-form' onSubmit={async event => {
      event.preventDefault(); if (!target || busy) return;
      const submitted = key; setBusy(true); setError('');
      try { await requestApi('/reports', { ...target, reason, evidence, audience: selectedAudience }); if (current.current === submitted) onClose(); toast.success('Report submitted'); }
      catch (e: any) { if (current.current === submitted) setError(e.message); } finally { setBusy(false); }
    }}>
      <label>Who can read this report<select aria-label='Who can read this report' disabled={busy} value={selectedAudience} onChange={event => setAudience(event.target.value as 'platform' | 'room')}><option value='platform'>Instance administrators only</option>{shareable && <option value='room'>Instance administrators and room moderators</option>}</select></label>
      <p role='note'>{selectedAudience === 'platform' ? 'Only instance administrators can read your identity, reason and evidence. This report will not appear in the room moderator queue.' : 'Instance administrators and currently authorized moderators of this room can read your identity, reason and evidence, including a moderator you are reporting. Moderator access can change when roles or membership change.'}</p>
      <label>Reason<textarea autoFocus disabled={busy} required minLength={5} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)}/></label>
      <label>Evidence you choose to share (optional)<textarea disabled={busy} maxLength={4000} value={evidence} onChange={event => setEvidence(event.target.value)} placeholder='Paste only the context you want the selected reviewers to read.'/></label>
      {error && <p className='connect-error' role='alert'>{error}</p>}<button className='primary-button' disabled={busy || reason.trim().length < 5}>{busy ? 'Submitting report…' : 'Submit report'}</button>
    </form>
  </DialogContent></Dialog>;
}
