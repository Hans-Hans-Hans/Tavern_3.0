import { useEffect, useState } from 'react';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { administerMember, canAdministerMember, canEditConversationDetails, conversationMemberLevel, saveConversationDetails, type ConversationAction } from '@/lib/channel-administration';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const labels: Record<ConversationAction, string> = { kick: 'Remove from conversation', ban: 'Ban from conversation', unban: 'Lift ban', moderator: 'Set native power to 50', member: 'Set native power to 0' };
const operations = Object.keys(labels) as ConversationAction[];
export function ChannelAdmin({ roomId, onChanged }: { roomId: string; onChanged: () => Promise<unknown> }) {
  const client = getMatrixClient(), room = client?.getRoom(roomId);
  const [name, setName] = useState(room?.name || ''), [topic, setTopic] = useState(room?.currentState.getStateEvents('m.room.topic', '')?.getContent().topic || '');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [target, setTarget] = useState(''), [action, setAction] = useState<ConversationAction | ''>(''), [reason, setReason] = useState('');
  const [pending, setPending] = useState<{ target: string; action: ConversationAction; reason: string; power: number } | null>(null), [confirmation, setConfirmation] = useState(''), [, refresh] = useState(0);
  useEffect(() => onMatrixUpdate(() => refresh(value => value + 1)), []);
  if (!room || !client?.getUserId()) return null;
  const canEdit = canEditConversationDetails(roomId);
  const members = room.getMembers().filter(member => operations.some(operation => canAdministerMember(roomId, member.userId, operation)));
  if (!canEdit && !members.length && !pending) return null;
  async function changed() { try { await onChanged(); } catch { setError('The change was saved, but refreshing the conversation failed. Reopen its details.'); } }
  return <section className='channel-admin'><h3>Manage conversation</h3>
    {canEdit && <form className='dialog-form' onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { await saveConversationDetails(roomId, name, topic); await changed(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
    }}><fieldset disabled={busy}><label>Name<input value={name} onChange={event => setName(event.target.value)} maxLength={60} required/></label><label>Topic<input value={topic} onChange={event => setTopic(event.target.value)} maxLength={500}/></label><button className='secondary-button'>Save conversation details</button></fieldset></form>}
    {!!members.length && <form className='dialog-form' onSubmit={event => {
      event.preventDefault(); const power = conversationMemberLevel(roomId, target);
      if (!action || power === null || !canAdministerMember(roomId, target, action)) { setError('Your authority or the selected member changed. Review the action.'); return; }
      setPending({ target, action, reason, power }); setConfirmation(''); setError('');
    }}><fieldset disabled={busy}><label>Member<select value={target} required onChange={event => { setTarget(event.target.value); setAction(''); }}><option value=''>Choose a member</option>{members.map(member => <option key={member.userId} value={member.userId}>{member.name} ({member.membership})</option>)}</select></label>
      <label>Action<select value={action} required onChange={event => setAction(event.target.value as ConversationAction)}><option value=''>Choose an action</option>{operations.filter(operation => canAdministerMember(roomId, target, operation)).map(operation => <option value={operation} key={operation}>{labels[operation]}</option>)}</select></label>
      {action && !['moderator', 'member'].includes(action) && <label>Reason<input value={reason} onChange={event => setReason(event.target.value)} maxLength={200}/></label>}
      <p className='login-help'>Native power controls permissions in this conversation. Server role assignments are managed separately in Server roles. Moderation reasons are visible to room members and the homeserver.</p>
      <button className='secondary-button' disabled={!action || !canAdministerMember(roomId, target, action)}>Review selected action…</button>
    </fieldset></form>}
    {error && !pending && <p className='connect-error' role='alert'>{error}</p>}
    <Dialog open={!!pending} onOpenChange={open => { if (!open && !busy) { setPending(null); setConfirmation(''); setError(''); } }}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>{pending ? labels[pending.action] : 'Confirm conversation action'}</DialogTitle><DialogDescription>{pending && ['moderator', 'member'].includes(pending.action) ? `Change ${pending.target}'s native power from ${pending.power} to ${pending.action === 'moderator' ? 50 : 0}. This changes their authority in this conversation.` : pending?.action === 'kick' ? 'The member will leave this conversation and may need a new invitation to return.' : pending?.action === 'ban' ? 'The member will leave and cannot return until an authorized member lifts the ban.' : 'The member will be allowed to rejoin, subject to the conversation’s invitation policy.'}</DialogDescription></DialogHeader>
      {pending && <form className='dialog-form' onSubmit={async event => {
        event.preventDefault(); if (confirmation !== pending.target) return; setBusy(true); setError('');
        try { await administerMember(roomId, pending.target, pending.action, pending.reason, pending.power); setPending(null); setTarget(''); setAction(''); setReason(''); setConfirmation(''); await changed(); }
        catch (e: any) { setError(e.message); } finally { setBusy(false); }
      }}><p>{pending.target}</p>{pending.reason && !['moderator', 'member'].includes(pending.action) && <p>Reason: {pending.reason}</p>}<label>Type the full Matrix user ID to confirm<input required autoComplete='off' value={confirmation} onChange={event => setConfirmation(event.target.value)}/></label>
        {!canAdministerMember(roomId, pending.target, pending.action) && <p className='connect-error'>Your permissions or the member’s status changed. Cancel and review the conversation.</p>}
        {error && <p className='connect-error' role='alert'>{error}</p>}<div className='product-actions'><button className='primary-button' disabled={busy || confirmation !== pending.target || !canAdministerMember(roomId, pending.target, pending.action)}>{busy ? 'Applying change…' : 'Confirm ' + labels[pending.action].toLowerCase()}</button><button type='button' className='secondary-button' disabled={busy} onClick={() => setPending(null)}>Cancel</button></div>
      </form>}
    </DialogContent></Dialog>
  </section>;
}
