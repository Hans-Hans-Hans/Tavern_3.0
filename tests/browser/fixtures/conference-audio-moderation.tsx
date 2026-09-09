import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, Room } from 'matrix-js-sdk';
import { ConferenceAudioModeration, type AudioModerationTarget } from '../../../app/conference-audio-moderation';
import { accountArtworkOwner, setAccountDevice } from '../../../lib/api';
import { clearConference, conferenceClosing, conferenceJoined, conferenceSnapshot, openConference } from '../../../lib/conference-session';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any, me = '@moderator:local';
  const client = createClient({ baseUrl: location.origin, userId: me, deviceId: 'D1' });
  const room = new Room('!channel:local', client, me, {}); room.updateMyMembership('join' as any);
  client.getRoom = id => id === room.roomId ? room : null;
  w.audioFixture = { client, room, listeners: new Set(), closed: 0, captures: 0 };
  const f = w.audioFixture; f.notify = () => f.listeners.forEach((listener: () => void) => listener());
  setAccountDevice('D1');
  f.changeAccount = () => { const before = accountArtworkOwner(); setAccountDevice('D2'); setAccountDevice('D1'); if (before === accountArtworkOwner()) throw new Error('Account generation did not change'); f.notify(); };
  f.leaveRoom = () => { room.updateMyMembership('leave' as any); f.notify(); };
  f.closeCall = conferenceClosing;
  f.replaceCall = () => { clearConference(conferenceSnapshot().generation); openConference(room.roomId); conferenceJoined(conferenceSnapshot().generation); };
  navigator.mediaDevices.getUserMedia = async () => { f.captures++; throw new Error('Moderation controls must not capture media'); };
  navigator.mediaDevices.getDisplayMedia = async () => { f.captures++; throw new Error('Moderation controls must not capture media'); };
  openConference(room.roomId); conferenceJoined(conferenceSnapshot().generation);
  function Fixture() {
    const [target, setTarget] = useState<AudioModerationTarget | null>({ userId: '@guest:local', name: 'Guest', action: new URLSearchParams(location.search).get('action') === 'deafened' ? 'deafened' : 'muted' });
    return target && <ConferenceAudioModeration key={target.userId + target.action} roomId={room.roomId} generation={conferenceSnapshot().generation} target={target} onClose={() => { f.closed++; setTarget(null); }}/>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
