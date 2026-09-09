import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner, requestApi } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { conferenceSnapshot, subscribeConference } from '@/lib/conference-session';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export type AudioModerationTarget = { userId: string; name: string; action: 'muted' | 'deafened' };
type Scope = { roomId: string; name: string; kind: 'channel' | 'server' };
type AudioState = {
  roomId: string; userId: string; available: boolean;
  local: { muted: boolean; deafened: boolean };
  effective: { muted: boolean; deafened: boolean };
  permissions: { mute: boolean; deafen: boolean };
  eventId: string | null; revision: string; scopes: Scope[];
  enforcement: { status: 'confirmed' | 'pending' | 'idle'; checkedAt: number | null; devices: number; rejoinRequired?: boolean };
};

function checkedState(value: AudioState, roomId: string, userId: string): AudioState {
  if (!value || value.roomId !== roomId || value.userId !== userId || typeof value.available !== 'boolean'
    || !/^[a-f0-9]{64}$/.test(value.revision) || !Array.isArray(value.scopes) || value.scopes.length > 32
    || value.scopes.some(scope => !scope || typeof scope.roomId !== 'string' || typeof scope.name !== 'string' || !['channel', 'server'].includes(scope.kind))
    || ['local', 'effective'].some(key => ['muted', 'deafened'].some(flag => typeof (value as any)[key]?.[flag] !== 'boolean'))
    || typeof value.permissions?.mute !== 'boolean' || typeof value.permissions?.deafen !== 'boolean'
    || !['confirmed', 'pending', 'idle'].includes(value.enforcement?.status)
    || !Number.isSafeInteger(value.enforcement.devices) || value.enforcement.devices < 0
    || value.enforcement.rejoinRequired !== undefined && typeof value.enforcement.rejoinRequired !== 'boolean') {
    throw new Error('The current audio permissions could not be checked. Refresh before making a change.');
  }
  return value;
}

/** Each mount belongs to one target and conference. Requests never cross that
 * account/device boundary, including API A-to-B-to-A session replacements. */
export function ConferenceAudioModeration({ roomId, generation, target, onClose }: {
  roomId: string; generation: number; target: AudioModerationTarget; onClose: () => void;
}) {
  const [owner] = useState(() => {
    const client = getMatrixClient();
    return { client, actor: client?.getUserId(), device: client?.getDeviceId(), account: accountArtworkOwner(), room: client?.getRoom(roomId), roomId, generation, target };
  });
  const alive = useRef(true), request = useRef(0), selectedScope = useRef(roomId);
  const [scopeId, setScopeId] = useState(roomId), [scopes, setScopes] = useState<Scope[]>([]);
  const [data, setData] = useState<AudioState | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [saved, setSaved] = useState(false), [blocked, setBlocked] = useState(false);
  const [, refresh] = useState(0);
  const current = () => {
    const call = conferenceSnapshot();
    return alive.current && target === owner.target && roomId === owner.roomId && generation === owner.generation
      && getMatrixClient() === owner.client && owner.client?.getUserId() === owner.actor && owner.client?.getDeviceId() === owner.device
      && accountArtworkOwner() === owner.account && owner.client?.getRoom(roomId) === owner.room && owner.room?.getMyMembership() === 'join'
      && call.roomId === roomId && call.generation === generation && call.phase !== 'closing' && call.phase !== 'idle';
  };
  const endpoint = (scope: string) => '/calls/audio/' + encodeURIComponent(scope) + '/' + encodeURIComponent(target.userId);
  async function load(scope: string) {
    if (!current()) return;
    const serial = ++request.current; selectedScope.current = scope;
    setScopeId(scope); setData(null); setBusy(true); setError(''); setSaved(false); setBlocked(false);
    try {
      const result = checkedState(await requestApi<AudioState>(endpoint(scope)), scope, target.userId);
      if (!current() || serial !== request.current || selectedScope.current !== scope) return;
      setData(result);
      setScopes(previous => [...new Map([...previous, ...result.scopes].map(item => [item.roomId, item])).values()]);
    } catch (failure) { if (current() && serial === request.current) setError((failure as Error).message); }
    finally { if (current() && serial === request.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true; void load(roomId);
    const update = () => { if (!current()) onClose(); else refresh(value => value + 1); };
    const off = onMatrixUpdate(update), offConference = subscribeConference(update);
    return () => { alive.current = false; request.current++; off(); offConference(); };
  }, [owner]);
  async function change() {
    if (!current() || busy || blocked || !data || !data.available && !data.local[target.action] || !data.permissions[target.action === 'muted' ? 'mute' : 'deafen']) return;
    const serial = ++request.current, scope = scopeId;
    setBusy(true); setError(''); setSaved(false);
    try {
      const result = await requestApi<AudioState & { saved: boolean }>(endpoint(scope), {
        change: { [target.action]: !data.local[target.action] }, revision: data.revision, confirmation: target.userId,
      });
      if (!current() || serial !== request.current || selectedScope.current !== scope) return;
      if (result.saved !== true) throw new Error('The change could not be confirmed. Refresh the current audio permissions.');
      setData(checkedState(result, scope, target.userId)); setSaved(true);
    } catch (failure) {
      if (current() && serial === request.current) { setError((failure as Error).message); setBlocked(true); }
    } finally { if (current() && serial === request.current) setBusy(false); }
  }
  if (!current()) return null;
  const mute = target.action === 'muted', permitted = data?.permissions[mute ? 'mute' : 'deafen'];
  const selected = scopes.find(scope => scope.roomId === scopeId);
  const status = data?.enforcement;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="tavern-dialog">
    <DialogHeader><DialogTitle>{mute ? 'Server mute' : 'Server deafen'}: {target.name}</DialogTitle>
      <DialogDescription>{mute ? 'Control whether this member can send conference audio.' : 'Control whether this member can hear conference audio.'} Changes apply to all their conference devices in the selected scope.</DialogDescription></DialogHeader>
    <p>{target.userId}</p>
    {!!scopes.length && <label>Apply in<select aria-label="Apply in" value={scopeId} disabled={busy} onChange={event => void load(event.target.value)}>
      {scopes.map(scope => <option key={scope.roomId} value={scope.roomId}>{scope.kind === 'server' ? 'Entire server: ' : 'This channel: '}{scope.name}</option>)}
    </select></label>}
    {busy && <p role="status">Checking audio permissions…</p>}
    {data && <>
      <p>{mute ? 'Sending audio' : 'Hearing audio'}: <strong>{data.effective[target.action] ? 'Restricted by a moderator' : 'Allowed'}</strong></p>
      {!data.local[target.action] && data.effective[target.action] && <p>A restriction from another scope still applies. Open that server scope to review it.</p>}
      {!data.available && <p>Adding server audio restrictions is unavailable. An administrator needs to finish the call-service setup. Authorized members can still clear a saved restriction.</p>}
      {!permitted && <p>Your current role cannot change this setting in {selected?.name || 'this scope'}.</p>}
      {saved && <p role="status">{status?.rejoinRequired ? 'Saved. This member needs to leave and rejoin the conference to restore audio on a restricted device.' : status?.status === 'pending' ? 'Saved. Waiting for the call service to confirm the change; current audio may continue until then.' : status?.status === 'idle' ? 'Saved. This setting applies when the member next joins a conference.' : 'Saved. Audio permissions confirmed for ' + status?.devices + ' connected device' + (status?.devices === 1 ? '.' : 's.')}</p>}
      {!saved && status?.status === 'pending' && <p role="status">The saved setting is waiting for confirmation from the call service.</p>}
      {!saved && status?.rejoinRequired && <p role="status">This member needs to leave and rejoin the conference to restore audio on a restricted device.</p>}
      <p>Removing a restriction allows audio again. The member controls whether their own microphone is on.</p>
      {permitted && <button className="primary-button" disabled={busy || blocked || !data.available && !data.local[target.action]} onClick={() => void change()}>{data.local[target.action] ? (mute ? 'Remove server mute' : 'Remove server deafen') : (mute ? 'Apply server mute' : 'Apply server deafen')}</button>}
    </>}
    {error && <p className="connect-error" role="alert">{error}{blocked && ' Refresh the current state before trying again.'}</p>}
    <button className="secondary-button" disabled={busy} onClick={() => void load(scopeId)}>Refresh audio status</button>
  </DialogContent></Dialog>;
}
