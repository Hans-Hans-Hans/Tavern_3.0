import { useEffect, useState } from 'react';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { canEditNativePermissions, conversationMemberLevel, saveNativePermissions } from '@/lib/channel-administration';
import { NotificationSettings } from './notification-settings';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function RoomPermissions({ roomId }: { roomId: string }) {
  const client = getMatrixClient(), room = client?.getRoom(roomId), me = client?.getUserId();
  const power = room?.currentState.getStateEvents('m.room.power_levels', '')?.getContent() || {};
  const [post, setPost] = useState(String(power.events?.['m.room.encrypted'] ?? power.events_default ?? 0)), [invite, setInvite] = useState(String(power.invite ?? 0)), [pin, setPin] = useState(String(power.events?.['m.room.pinned_events'] ?? power.state_default ?? 50)), [conference, setConference] = useState(String(power.events?.['org.matrix.msc3401.call.member'] ?? power.state_default ?? 50));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [confirming, setConfirming] = useState(false), [confirmation, setConfirmation] = useState(''), [, refresh] = useState(0);
  useEffect(() => onMatrixUpdate(() => refresh(value => value + 1)), []);
  if (!client || !room || !me) return null;
  const allowed = canEditNativePermissions(roomId), level = conversationMemberLevel(roomId, me) ?? -Infinity;
  const select = (label: string, value: string, set: (value: string) => void, original: number) => <label>{label}<select value={value} disabled={original > level} onChange={event => set(event.target.value)}>{[0, 50, 100].map(option => <option key={option} value={option} disabled={option > level && String(option) !== value}>{option === 0 ? 'Members' : option === 50 ? 'Moderators' : 'Administrators'} ({option})</option>)}{!['0', '50', '100'].includes(value) && <option value={value}>Custom ({value})</option>}</select>{original > level && <small>This permission is above your native authority.</small>}</label>;
  return <section className='channel-admin'><NotificationSettings roomId={roomId}/>
    {allowed && <><h3>Channel permissions</h3><form className='dialog-form' onSubmit={event => { event.preventDefault(); setConfirming(true); setConfirmation(''); setMessage(''); }}><fieldset disabled={busy}>
      {select('Send messages and encrypted events', post, setPost, Math.max(power.events?.['m.room.message'] ?? power.events_default ?? 0, power.events?.['m.room.encrypted'] ?? power.events_default ?? 0))}{select('Invite people', invite, setInvite, power.invite ?? 0)}{select('Pin messages', pin, setPin, power.events?.['m.room.pinned_events'] ?? power.state_default ?? 50)}{select('Join conferences', conference, setConference, power.events?.['org.matrix.msc3401.call.member'] ?? power.state_default ?? 50)}
      <p className='login-help'>These native room permissions set the minimum authority for each action. Server and category roles also apply. On servers with role policies, only the server owner can change native powers.</p><button className='secondary-button'>Review permission changes…</button>
    </fieldset></form></>}{message && !confirming && <p role='status'>{message}</p>}
    <Dialog open={confirming} onOpenChange={open => { if (!busy) { setConfirming(open); setConfirmation(''); setMessage(''); } }}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Change channel permissions?</DialogTitle><DialogDescription>Changing native permissions affects who can send messages, invite people, pin messages, and join conferences in this conversation.</DialogDescription></DialogHeader><form className='dialog-form' onSubmit={async event => {
      event.preventDefault(); if (confirmation !== roomId) return; setBusy(true); setMessage('');
      try { await saveNativePermissions(roomId, { post: Number(post), invite: Number(invite), pin: Number(pin), conference: Number(conference) }); setConfirming(false); setConfirmation(''); setMessage('Channel permissions saved.'); }
      catch (e: any) { setMessage(e.message); } finally { setBusy(false); }
    }}><dl><dt>Send messages</dt><dd>Power {post}</dd><dt>Invite people</dt><dd>Power {invite}</dd><dt>Pin messages</dt><dd>Power {pin}</dd><dt>Join conferences</dt><dd>Power {conference}</dd></dl><p>{room.name} · <code>{roomId}</code></p><label>Type the room ID to confirm<input required autoComplete='off' value={confirmation} onChange={event => setConfirmation(event.target.value)}/></label>
      {!allowed && <p className='connect-error'>Your permission to manage native room powers changed. Cancel and reopen the panel.</p>}{message && <p className='connect-error' role='alert'>{message}</p>}<div className='product-actions'><button className='primary-button' disabled={busy || !allowed || confirmation !== roomId}>{busy ? 'Saving permissions…' : 'Confirm channel permissions'}</button><button type='button' className='secondary-button' disabled={busy} onClick={() => setConfirming(false)}>Cancel</button></div>
    </form></DialogContent></Dialog>
  </section>;
}
