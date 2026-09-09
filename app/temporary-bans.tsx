import { useEffect, useState } from 'react';
import { isManagedAccount, requestApi } from '@/lib/api';
import { roomContext } from '@/lib/channel-policy';
import { effectiveRolePermissions, memberRoleRank } from '@/lib/roles';
import { onMatrixUpdate } from '@/lib/matrix';
import { Field } from './auth-gateway';

const eventType = 'io.tavern.tempban';
type Restriction = { roomId: string; targetId: string; eventId: string | null; until: number | null; active: boolean; reason: string; actor: string | null };
type Snapshot = { restriction: Restriction; inherited: Restriction[]; membership: string; scope: 'server' | 'room' };
type Outcome = { restrictionApplied: boolean; until: number; eventId: string; membershipRemoved: boolean; message: string; scope: 'server' | 'room' };
function permitted(roomId: string, target?: string) {
  try {
    const { room, me, policies, unknownPolicy } = roomContext(roomId), actorPower = room.getMember(me)?.powerLevel || 0;
    if (unknownPolicy || !room.currentState.hasSufficientPowerLevelFor('ban', actorPower) || !room.currentState.maySendStateEvent(eventType, me)) return false;
    if (target && (target === me || (room.getMember(target)?.powerLevel || 0) >= actorPower)) return false;
    return policies.every(policy => effectiveRolePermissions(policy, me, roomId).has('ban') && (!target || memberRoleRank(policy, me) > memberRoleRank(policy, target)));
  } catch { return false; }
}
const deadline = (until: number | null) => until === null ? 'invalid expiry; still restricted until repaired' : until ? new Date(until).toLocaleString() : 'lifted';

export function TemporaryBans({ roomId, userId }: { roomId: string; userId?: string }) {
  const [target, setTarget] = useState(userId || ''), [reviewed, setReviewed] = useState(userId || ''), [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [duration, setDuration] = useState(86400), [reason, setReason] = useState(''), [confirmation, setConfirmation] = useState(''), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [outcome, setOutcome] = useState<Outcome | null>(null), [, redraw] = useState(0);
  useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  const allowed = isManagedAccount() && permitted(roomId);
  useEffect(() => { setTarget(userId || ''); setReviewed(userId || ''); setConfirmation(''); setReason(''); setOutcome(null); }, [roomId, userId]);
  useEffect(() => {
    setSnapshot(null); if (!allowed || !reviewed) return;
    let live = true; setBusy(true); setError('');
    void requestApi<Snapshot>('/moderation/temporary-bans?' + new URLSearchParams({ roomId, targetId: reviewed })).then(value => { if (live) setSnapshot(value); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [roomId, reviewed, revision, allowed]);
  if (!allowed) return null;
  const canSubmit = !!snapshot && permitted(roomId, reviewed) && confirmation === reviewed && !busy;
  async function submit(action: 'apply' | 'lift') {
    if (!snapshot || !canSubmit) return;
    setBusy(true); setError(''); setOutcome(null);
    try {
      const value = await requestApi<Outcome>('/moderation/temporary-bans', { action, roomId, targetId: reviewed, confirmation, previousEventId: snapshot.restriction.eventId, reason: reason.trim(), durationSeconds: duration });
      setOutcome(value); setConfirmation(''); setReason(''); setRevision(current => current + 1);
    } catch (e: any) { setError(e.message); if (e.status === 409) { setSnapshot(null); setConfirmation(''); } }
    finally { setBusy(false); }
  }
  return <section className='product-section'><h3>Temporary bans</h3><p>A temporary ban prevents writes, new call participation, invitations and rejoining until its expiry. Tavern then attempts to remove the member from this room. Expiry is enforced by the server even while moderators are offline.</p>
    <form className='dialog-form' onSubmit={event => { event.preventDefault(); setReviewed(target.trim()); setConfirmation(''); setOutcome(null); setRevision(value => value + 1); }}><Field label='Member to review for a temporary ban'><input required readOnly={!!userId} maxLength={510} value={target} onChange={event => setTarget(event.target.value)} placeholder='@member:example.com'/></Field><button className='secondary-button' disabled={busy}>Review temporary ban</button></form>
    {busy && <p role='status'>Checking temporary ban…</p>}{error && <p role='alert' className='connect-error'>{error}</p>}
    {outcome && <p role='status' className={outcome.restrictionApplied && !outcome.membershipRemoved ? 'connect-error' : ''}>{outcome.message}{outcome.until > 0 && <> Expiry: {deadline(outcome.until)}.</>}</p>}
    {snapshot && <><p>Current membership: {snapshot.membership}. {snapshot.restriction.active ? <>Temporary ban active until {deadline(snapshot.restriction.until)}.</> : 'No active temporary ban in this room.'}</p>{snapshot.restriction.reason && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Recorded reason: {snapshot.restriction.reason}</p>}
      {snapshot.inherited.filter(value => value.active).map(value => <p key={value.roomId}>An inherited server ban remains active until {deadline(value.until)}. It must be lifted in its server: {value.roomId}.</p>)}
      <p>{snapshot.scope === 'server' ? 'This server ban also prevents writes and admission in its canonical child channels. Existing child-channel membership and readable history remain; remove the member from those channels separately when needed. ' : ''}Existing media connections require the call moderation controls. A lifted or expired ban does not automatically rejoin or reinvite the member.</p>
      <form className='dialog-form' onSubmit={event => { event.preventDefault(); void submit('apply'); }}><Field label='Temporary ban duration'><select disabled={busy} value={duration} onChange={event => setDuration(Number(event.target.value))}><option value={3600}>1 hour</option><option value={86400}>24 hours</option><option value={604800}>7 days</option><option value={2419200}>28 days</option></select></Field><Field label='Reason visible in room state'><textarea disabled={busy} maxLength={500} value={reason} onChange={event => setReason(event.target.value)}/></Field><p className='login-help'>The reason is visible to people with access to room state. Use the private warning inbox for sensitive details.</p><Field label={'Type ' + reviewed + ' to confirm the temporary ban change'}><input disabled={busy} autoComplete='off' value={confirmation} onChange={event => setConfirmation(event.target.value)}/></Field>
        <div className='product-actions'><button className='danger-button' disabled={!canSubmit || !reason.trim() || snapshot.membership === 'ban'}>{snapshot.restriction.active ? 'Replace temporary ban duration' : 'Apply temporary ban'}</button><button type='button' className='secondary-button' disabled={!canSubmit || !snapshot.restriction.active} onClick={() => void submit('lift')}>Lift temporary ban</button></div>{snapshot.membership === 'ban' && <p>A permanent Matrix ban remains in place. Temporary ban controls do not remove it.</p>}
      </form></>}
  </section>;
}
