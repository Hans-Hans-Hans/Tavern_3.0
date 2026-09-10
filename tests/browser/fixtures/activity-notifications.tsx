import React from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { ActivityNotifications } from '../../../app/activity-notifications';
import { CallPanel } from '../../../app/call-panel';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any;
  w.listeners = new Set(); w.callListeners = new Set(); w.streams = []; w.notices = []; w.accounts = {}; w.reads = 0; w.sounds = 0; w.answers = 0;
  w.social = { requests: [{ id: 'existing', sender: '@old:local', target: '@me:local', status: 'pending', created: 1 }], blocked: [], privacy: 'everyone' };
  w.fakeHidden = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => w.fakeHidden ? 'hidden' : 'visible' });
  w.EventSource = class { onmessage: any; closed = false; constructor(public url: string) { w.streams.push(this); } close() { this.closed = true; } };
  w.Notification = class { static permission = 'granted'; closed = false; onclick: any; constructor(public title: string, public options: any) { w.notices.push(this); } close() { this.closed = true; } };
  const peer = { userId: '@private-caller:local', name: 'Private caller name' };
  const room = { roomId: '!dm:local', name: 'Private room name', isSpaceRoom: () => false, getMyMembership: () => 'join', getJoinedMembers: () => [peer], currentState: { getStateEvents: (type: string) => type === 'm.space.parent' ? [] : null } };
  w.fixtureClient = { getUserId: () => '@me:local', getDeviceId: () => 'ACTIVITY-DEVICE', getHomeserverUrl: () => location.origin + '/api/matrix', getIgnoredUsers: () => w.ignored || [], getRooms: () => [room], getRoom: (id: string) => id === '!dm:local' ? room : null, getAccountData: (key: string) => w.accounts[key] ? { getContent: () => w.accounts[key] } : null };
  w.media = { audioInput: '', videoInput: '', audioOutput: '', outputVolume: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true, deafened: false, pushToTalk: false };
  w.ring = (id: string) => { w.call = { callId: id, roomId: '!dm:local', state: 'ringing', direction: 'inbound', getOpponentMember: () => peer }; w.callListeners.forEach((fn: any) => fn()); };
  w.emitContacts = () => { w.streams.filter((stream: any) => !stream.closed).forEach((stream: any) => stream.onmessage?.({ data: 'changed' })); };
  createRoot(document.getElementById('root')!).render(<><ActivityNotifications onOpenContacts={() => { w.contactsOpened = true; }}/><CallPanel/><Toaster/></>);
}
