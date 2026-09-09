import { useEffect, useState } from 'react';
import { accountArtworkOwner, requestApi } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { conferenceSnapshot, subscribeConference } from '@/lib/conference-session';

/** Show the affected member their own authoritative restrictions. This neither
 * changes capture choices nor treats the saved flags as confirmed media state. */
export function ConferenceAudioStatus({ roomId, generation }: { roomId: string; generation: number }) {
  const [owner] = useState(() => { const client = getMatrixClient(); return { client, account: accountArtworkOwner(), user: client?.getUserId(), device: client?.getDeviceId(), room: client?.getRoom(roomId), roomId, generation }; });
  const [status, setStatus] = useState<{ muted: boolean; deafened: boolean; pending: boolean; rejoin: boolean } | null>(null);
  const current = () => {
    const call = conferenceSnapshot();
    return roomId === owner.roomId && generation === owner.generation && getMatrixClient() === owner.client
      && accountArtworkOwner() === owner.account && owner.client?.getUserId() === owner.user && owner.client?.getDeviceId() === owner.device
      && owner.client?.getRoom(roomId) === owner.room && owner.room?.getMyMembership() === 'join'
      && call.roomId === roomId && call.generation === generation && call.phase !== 'idle' && call.phase !== 'closing';
  };
  useEffect(() => {
    let alive = true, busy = false, next: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      if (!alive || !current() || busy || !owner.user) return;
      busy = true;
      try {
        const value = await requestApi('/calls/audio/' + encodeURIComponent(roomId) + '/' + encodeURIComponent(owner.user));
        if (!alive || !current()) return;
        if (value.roomId !== roomId || value.userId !== owner.user || typeof value.effective?.muted !== 'boolean'
          || typeof value.effective?.deafened !== 'boolean' || !['confirmed', 'pending', 'idle'].includes(value.enforcement?.status)) throw new Error('Invalid audio status');
        setStatus({ ...value.effective, pending: value.enforcement.status === 'pending', rejoin: value.enforcement.rejoinRequired === true });
      } catch { if (alive && current()) setStatus(null); }
      finally { busy = false; }
    }
    const update = () => {
      if (!current()) { setStatus(null); return; }
      if (!next) next = setTimeout(() => { next = undefined; void read(); }, 1000);
    };
    const off = onMatrixUpdate(update), offCall = subscribeConference(update), timer = setInterval(() => void read(), 15000);
    void read();
    return () => { alive = false; off(); offCall(); clearInterval(timer); clearTimeout(next); };
  }, [owner]);
  if (!current() || !status || !status.muted && !status.deafened && !status.rejoin) return null;
  return <p className="call-control-caption" role="status">
    {status.muted && 'A moderator has restricted your outgoing conference audio. '}
    {status.deafened && 'A moderator has restricted the conference audio you can hear. '}
    {status.rejoin ? 'Leave and rejoin this conference to restore audio. Your microphone settings still apply.' : status.pending ? 'The call service has not confirmed this change on all devices yet.' : 'These restrictions apply to audio.'}
  </p>;
}
