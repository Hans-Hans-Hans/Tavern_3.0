import { useEffect, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import { idleConferenceEnded, leaveIdleConference, monitorCallInteraction } from '@/lib/call-idle';
import { conferenceAfk } from '@/lib/server-afk';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { conferenceSnapshot } from '@/lib/conference-session';

export function ConferenceIdle({ roomId, generation, joined, frame, onLeave }: { roomId: string; generation: number; joined: boolean; frame: RefObject<HTMLIFrameElement | null>; onLeave: (() => Promise<boolean>) | null }) {
  const [enabled, setEnabled] = useState(false), [remaining, setRemaining] = useState<number | null>(null), [, redraw] = useState(0);
  const settings = conferenceAfk(roomId), client = getMatrixClient(), key = JSON.stringify([generation, roomId, settings]), current = useRef(key); current.current = key;
  const stay = useRef<(() => void) | null>(null);
  useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  useEffect(() => { setEnabled(false); setRemaining(null); }, [key, client]);
  useEffect(() => {
    if (!enabled || !joined || !settings || !onLeave) return;
    const monitor = monitorCallInteraction(frame.current, settings.timeoutSeconds, setRemaining, () => {
      if (current.current !== key || getMatrixClient() !== client || JSON.stringify([generation, roomId, conferenceAfk(roomId)]) !== key) return;
      setEnabled(false);
      void leaveIdleConference(roomId, generation, onLeave, conferenceSnapshot).then(left => {
        if (!left || getMatrixClient() !== client || JSON.stringify([generation, roomId, conferenceAfk(roomId)]) !== key) return;
        toast('Conference left after inactivity.', {
          description: 'Open ' + settings.destinationName + ' and choose whether to join its conference. Opening the channel does not start a call.',
          duration: 20000,
          action: { label: 'Open AFK channel', onClick: () => {
            if (getMatrixClient() !== client || !idleConferenceEnded(generation, conferenceSnapshot) || conferenceAfk(roomId)?.channelId !== settings.channelId) { toast.error('Your call, AFK destination, or access changed.'); return; }
            location.hash = 'room=' + encodeURIComponent(settings.channelId);
          } },
        });
      }).catch(() => { if (getMatrixClient() === client && conferenceSnapshot().generation === generation) toast.error('The conference could not finish leaving. Use Leave conference to retry.'); });
    });
    stay.current = monitor.activity;
    return () => { monitor(); if (stay.current === monitor.activity) stay.current = null; };
  }, [enabled, joined, key, client, onLeave]);
  if (!settings || !joined) return null;
  return <div className='conference-idle'><label className='check-label'><input type='checkbox' checked={enabled} onChange={event => { setEnabled(event.target.checked); setRemaining(null); }}/>Leave this conference after {settings.timeoutSeconds / 60} minutes without interaction</label>
    <small>Applies to this call in this tab only. Speech, listening and screen sharing do not reset the timer. You will get a 30-second warning, then a link to {settings.destinationName}. You choose whether to join there.</small>
    {remaining !== null && <p role='status'>Leaving in {remaining} seconds because this Tavern tab has been idle. <button className='secondary-button' onClick={() => stay.current?.()}>Stay in conference</button></p>}
  </div>;
}
