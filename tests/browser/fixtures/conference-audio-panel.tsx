import React from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { ConferencePanel } from '../../../app/conference-panel';
import { accountArtworkOwner, setAccountDevice, setManagedAccount } from '../../../lib/api';
import { clearConference, conferenceSnapshot, openConference } from '../../../lib/conference-session';
import '../../../app/globals.css';

/** Keep the actual panel/session/menu/dialog. Only native sync and iframe media
 * are supplied by the fixture; the API module still performs real HTTP calls. */
export function mountFixture() {
  const w = window as any, me = '@moderator:local';
  const client = createClient({ baseUrl: location.origin, userId: me, deviceId: 'D1' });
  const rooms = new Map<string, Room>(), sessions = new Map();
  for (const [id, name] of [['!channel:local', 'Call room'], ['!other:local', 'Other call'], ['!selected:local', 'Selected text channel']]) {
    const room = new Room(id, client, me, {}); room.name = name; room.updateMyMembership('join' as any);
    room.currentState.setStateEvents([['@moderator:local', 'Moderator'], ['@guest:local', 'Guest']].map(([userId, displayname]) => new MatrixEvent({
      type: 'm.room.member', room_id: id, sender: userId, state_key: userId, event_id: '$' + id + userId,
      content: { membership: 'join', displayname },
    })));
    rooms.set(id, room);
    const listeners = new Set();
    sessions.set(id, { memberships: [{ userId: me }, { userId: '@guest:local' }, { userId: '@guest:local' }], on: (_event: string, fn: () => void) => listeners.add(fn), off: (_event: string, fn: () => void) => listeners.delete(fn) });
  }
  client.getRoom = id => rooms.get(id) || null;
  client.getRooms = () => [...rooms.values()];
  client.matrixRTC.getRoomSession = ((room: Room) => sessions.get(room.roomId)) as any;
  const f = w.audioPanelFixture = { client, rooms, listeners: new Set(), mounts: [] as string[], stops: [] as string[], captures: 0 };
  f.notify = () => f.listeners.forEach((listener: () => void) => listener());
  f.snapshot = conferenceSnapshot;
  f.replaceCall = (roomId = '!other:local') => { clearConference(conferenceSnapshot().generation); openConference(roomId); };
  f.changeAccount = () => {
    const owner = accountArtworkOwner(); setAccountDevice('D2'); setAccountDevice('D1');
    if (owner === accountArtworkOwner()) throw new Error('Expected a new API account generation');
    f.notify();
  };
  navigator.mediaDevices.getUserMedia = async () => { f.captures++; throw new Error('The moderation fixture must not capture media'); };
  navigator.mediaDevices.getDisplayMedia = async () => { f.captures++; throw new Error('The moderation fixture must not capture media'); };
  setAccountDevice('D1'); setManagedAccount(new URLSearchParams(location.search).get('managed') !== 'false');
  // Navigation remains on another channel while the persistent call owns its room.
  location.hash = 'room=' + encodeURIComponent('!selected:local');
  openConference('!channel:local');
  createRoot(document.getElementById('root')!).render(<ConferencePanel/>);
}
