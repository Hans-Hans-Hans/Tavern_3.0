import { useState } from 'react';
import { matrixApi, getMatrixClient } from '@/lib/matrix';

export function ChannelAdmin({ roomId, onChanged }: { roomId: string; onChanged: () => Promise<unknown> }) {
  const client = getMatrixClient();
  const room = client?.getRoom(roomId);
  const me = client?.getUserId();
  const [name, setName] = useState(room?.name || '');
  const [topic, setTopic] = useState(room?.currentState.getStateEvents('m.room.topic', '')?.getContent().topic || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');
  const [action, setAction] = useState('');
  const [reason, setReason] = useState('');
  if (!room || !me) return null;
  const canEdit = room.currentState.maySendStateEvent('m.room.name', me) && room.currentState.maySendStateEvent('m.room.topic', me);
  const canKick = room.currentState.hasSufficientPowerLevelFor('kick', room.getMember(me)?.powerLevel || 0);
  const canBan = room.currentState.hasSufficientPowerLevelFor('ban', room.getMember(me)?.powerLevel || 0);
  const canRole = room.currentState.maySendStateEvent('m.room.power_levels', me);
  if (!canEdit && !canKick && !canBan && !canRole) return null;
  async function run(action: string, data: object) {
    setBusy(true); setError('');
    try { await matrixApi(action, { conversation: roomId, ...data }); await onChanged(); setTarget(''); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="channel-admin"><h3>Manage conversation</h3>
    {canEdit && <form className="dialog-form" onSubmit={e => { e.preventDefault(); run('roomSettings', { name, topic }); }}>
      <label>Name<input value={name} onChange={e => setName(e.target.value)} maxLength={60} required /></label>
      <label>Topic<input value={topic} onChange={e => setTopic(e.target.value)} maxLength={500} /></label>
      <button className="secondary-button" disabled={busy}>Save conversation details</button>
    </form>}
    {(canKick || canBan || canRole) && <form className="dialog-form" onSubmit={e => { e.preventDefault(); run('moderate', { userId: target, operation: action, reason }); }}>
      <label>Member<select value={target} onChange={e => setTarget(e.target.value)} required><option value="">Choose a member</option>{room.getMembers().filter(m => m.userId !== me && ['join', 'invite', 'ban'].includes(m.membership || '')).map(m => <option key={m.userId} value={m.userId}>{m.name} ({m.membership})</option>)}</select></label>
      <label>Action<select value={action} onChange={e => setAction(e.target.value)} required><option value="">Choose an action</option>
        {canKick && <option value="kick">Remove from conversation</option>}
        {canBan && <><option value="ban">Ban from conversation</option><option value="unban">Lift ban</option></>}
        {canRole && <><option value="moderator">Set role: moderator (50)</option><option value="member">Set role: member (0)</option></>}
      </select></label>
      <label>Reason<input value={reason} onChange={e => setReason(e.target.value)} maxLength={200} /></label>
      <p className="login-help">These changes apply to this conversation. The homeserver checks your authority and the target’s role. Existing copies of messages remain on their devices.</p>
      <button className="secondary-button" disabled={busy || !target || !action}>Apply selected action</button>
    </form>}
    {error && <p className="connect-error" role="alert">{error}</p>}
  </section>;
}
