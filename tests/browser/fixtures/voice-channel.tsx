import React from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { Toaster } from 'sonner';
import { VoiceChannel } from '../../../app/voice-channel';
import { ConferencePanel } from '../../../app/conference-panel';
import { accountArtworkOwner, setAccountDevice, setManagedAccount } from '../../../lib/api';
import { clearConference, conferenceSnapshot, openConference } from '../../../lib/conference-session';
import { voiceChannelView } from '../../../lib/voice-channel-view';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any, me = '@owner:local', guest = '@guest:local';
  const client = createClient({ baseUrl: location.origin, userId: me, deviceId: 'D1' });
  const rooms = new Map<string, Room>(), sessions = new Map<string, any>();
  const f = w.voiceFixture = { client, rooms, sessions, actor: me, listeners: new Set(), mounts: [] as any[], stops: [] as string[], profiles: [] as string[], captures: 0, configured: true, direct: null, telemetry: [] as any[], screen: '!voice:local' };
  f.notify = () => f.listeners.forEach((listener: () => void) => listener());
  for (const [id, name, kind] of [['!voice:local', 'Voice lounge', 'voice'], ['!other:local', 'Other lounge', 'voice'], ['!video:local', 'Video meeting', 'video']]) {
    const room = new Room(id, client, me, {}); room.name = name; room.updateMyMembership('join' as any);
    const state = (type: string, content: any, key = '') => new MatrixEvent({ type, content, state_key: key, sender: me, room_id: id, event_id: '$' + type + id + key });
    room.currentState.setStateEvents([state('m.room.create', { room_version: '12', 'm.federate': false }), state('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }),
      state('m.room.power_levels', { users: { [me]: 100 }, events: { 'org.matrix.msc3401.call.member': 0 } }),
      state('io.tavern.channel', { version: 1, kind, archived: false, slowModeSeconds: 0 }),
      state('m.room.member', { membership: 'join', displayname: 'Owner' }, me), state('m.room.member', { membership: 'join', displayname: 'Guest' }, guest),
      state('m.room.member', { membership: 'leave', displayname: 'Departed' }, '@departed:local')]);
    rooms.set(id, room);
    const listeners = new Set(); sessions.set(id, { memberships: [{ userId: me }, { userId: guest }, { userId: guest }, { userId: '@departed:local' }, { userId: '@unknown:local' }],
      on: (_event: string, fn: () => void) => listeners.add(fn), off: (_event: string, fn: () => void) => listeners.delete(fn), listeners });
  }
  client.getRoom = id => rooms.get(id) || null; client.getRooms = () => [...rooms.values()];
  client.matrixRTC.getRoomSession = ((room: Room) => sessions.get(room.roomId)) as any;
  f.snapshot = conferenceSnapshot; f.view = voiceChannelView;
  f.member = (roomId: string, userId: string, membership: string) => {
    const room = rooms.get(roomId)!;
    room.currentState.setStateEvents([new MatrixEvent({ type: 'm.room.member', room_id: roomId, sender: userId, state_key: userId, event_id: '$membership-' + Date.now(), content: { membership, displayname: userId === me ? 'Owner' : 'Guest' } })]);
    if (userId === me) room.updateMyMembership(membership as any); f.notify();
  };
  f.kind = (kind: string) => { const id = conferenceSnapshot().roomId || '!voice:local'; rooms.get(id)!.currentState.setStateEvents([new MatrixEvent({ type: 'io.tavern.channel', room_id: id, sender: me, state_key: '', event_id: '$changed-kind', content: { version: 1, kind, archived: false, slowModeSeconds: 0 } })]); f.notify(); };
  f.account = () => { const previous = accountArtworkOwner(); setAccountDevice('D2'); setAccountDevice('D1'); if (previous === accountArtworkOwner()) throw new Error('Expected owner retirement'); f.notify(); };
  f.replaceRoom = () => { const id = '!voice:local', previous = rooms.get(id)!; const replacement = new Room(id, client, me, {}); replacement.name = previous.name; replacement.updateMyMembership('join' as any); replacement.currentState.setStateEvents(['m.room.create', 'm.room.member', 'm.room.encryption', 'm.room.power_levels', 'io.tavern.channel'].flatMap(type => previous.currentState.getStateEvents(type))); rooms.set(id, replacement); f.notify(); };
  f.open = (id: string) => { clearConference(conferenceSnapshot().generation); openConference(id); };
  f.sample = () => ({ connected: true, reconnecting: false, complete: true, e2eeEnabled: true,
    participants: [{ identity: 'fixture-owner', userId: me, deviceId: 'D1', displayName: 'Owner', avatarMxc: null, local: true, speaking: false, microphoneEnabled: true, cameraEnabled: false, screenShareEnabled: false, e2eeEnabled: true, encrypted: true },
      { identity: 'fixture-guest', userId: guest, deviceId: 'D2', displayName: 'Guest', avatarMxc: null, local: false, speaking: true, microphoneEnabled: true, cameraEnabled: false, screenShareEnabled: false, e2eeEnabled: true, encrypted: true }],
    metrics: { rttMs: 42.4, jitterMs: 2.25, packetLossPercent: 0.5, sampledTracks: 2, totalTracks: 2 } });
  f.publish = (value: any, index = f.telemetry.length - 1) => f.telemetry[index]?.(value);
  navigator.mediaDevices.getUserMedia = async () => { f.captures++; throw new Error('The UI fixture must not capture media'); };
  navigator.mediaDevices.getDisplayMedia = async () => { f.captures++; throw new Error('The UI fixture must not capture media'); };
  setAccountDevice('D1'); setManagedAccount(false);
  const root = createRoot(document.getElementById('root')!);
  f.render = (id = f.screen) => { f.screen = id; root.render(<><main style={{ margin: '30px auto', maxWidth: 900, height: 640, display: 'flex' }}>{id ? <VoiceChannel key={id} roomId={id} name={rooms.get(id)?.name || 'Voice'} onProfile={user => f.profiles.push(user)}/> : <p>Browsing another conversation</p>}</main><ConferencePanel/><Toaster/></>); };
  f.render();
}
