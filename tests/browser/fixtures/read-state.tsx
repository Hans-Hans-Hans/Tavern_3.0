import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, MatrixEvent, NotificationCountType, Room } from 'matrix-js-sdk';
import { Toaster } from 'sonner';
import { ChannelNavigation } from '../../../app/channel-navigation';
import { ReadStateBadges, MarkAllReadButton, useMarkReadAction } from '../../../app/read-state';
import { KeyboardShortcuts } from '../../../app/keyboard-shortcuts';
import { accountArtworkOwner, setAccountDevice } from '../../../lib/api';
import { markRoomsRead, navigationAccountKey, roomReadCounts, watchRoomReadCounts } from '../../../lib/read-state';
import '../../../app/globals.css';

export async function mountFixture() {
  const f: any = { actor: '@reader:local', calls: [], listeners: new Set(), batches: 0, failed: false, receipts: 0 };
  f.client = createClient({ baseUrl: location.origin, userId: f.actor, deviceId: 'A', timelineSupport: true });
  (window as any).readFixture = f; f.emit = () => f.listeners.forEach((fn: any) => fn());
  const add = async (id: string, name: string, unread: number, mentions: number) => {
    const room = new Room(id, f.client, f.actor, { pendingEventOrdering: 'detached' } as any); room.name = name; room.updateMyMembership('join');
    f.client.store.storeRoom(room); await room.addLiveEvents([new MatrixEvent({ event_id: '$event-' + id, room_id: id, sender: '@peer:local', origin_server_ts: 1, type: 'm.room.message', content: { body: 'Already loaded', msgtype: 'm.text' } })], {});
    room.setUnreadNotificationCount(NotificationCountType.Total, unread); room.setUnreadNotificationCount(NotificationCountType.Highlight, mentions); return room;
  };
  f.channel = await add('!channel:local', 'General', 8, 2); f.dm = await add('!dm:local', 'Direct message', 120, 105); f.manual = await add('!manual:local', 'Manual marker', 0, 0);
  const account = () => f.client.getAccountData(navigationAccountKey)?.getContent() || {};
  const store = (value: any) => { f.client.store.storeAccountDataEvents([new MatrixEvent({ type: navigationAccountKey, content: value })]); f.emit(); };
  store({ favorites: [], unread: [f.manual.roomId] });
  f.client.http.authedRequest = async (method: string, path: string, _query: any, body: any) => {
    f.calls.push({ method, path, body });
    if (path.includes('/receipt/')) { f.receipts++; await f.beforeReceipt?.(); if (f.failed && path.includes(encodeURIComponent(f.dm.roomId))) throw new Error('Receipt denied by fixture homeserver'); return {}; }
    if (path.includes('/account_data/')) { if (method === 'GET') return structuredClone(account()); store(body); return {}; }
    throw new Error('Unexpected native request: ' + path);
  };
  f.client.supportsThreads = () => true;
  f.mark = async (ids?: readonly string[]) => {
    f.batches++; const client = f.client, actor = f.actor, generation = accountArtworkOwner();
    return markRoomsRead({ client, current: () => f.client === client && f.actor === actor && accountArtworkOwner() === generation, mutateAccountData: async (key, update, validate) => {
      const old = await client.http.authedRequest('GET', '/user/' + encodeURIComponent(actor) + '/account_data/' + key); validate(); await client.setAccountData(key, update(old)); validate();
    } }, ids);
  };
  f.setDevice = (device: string, notify = true) => { setAccountDevice(device); if (notify) f.emit(); };
  setAccountDevice('A');
  function Fixture() {
    const [, render] = useState(0), [muted, setMuted] = useState(false), [focus, setFocus] = useState(false), [active, setActive] = useState(f.manual.roomId);
    useEffect(() => { const update = () => render(n => n + 1); f.listeners.add(update); const stop = watchRoomReadCounts(f.client, update); return () => { f.listeners.delete(update); stop(); }; }, []);
    const action = useMarkReadAction(f.mark), rooms = [f.channel, f.manual], manual = account().unread || [];
    return <><label><input type="checkbox" checked={muted} onChange={event => setMuted(event.target.checked)}/>Mute badges</label><label><input type="checkbox" checked={focus} onChange={event => setFocus(event.target.checked)}/>Focus mode</label>
      <ChannelNavigation channels={rooms.map(room => ({ id: room.roomId, name: room.name, ...roomReadCounts(room), manualUnread: manual.includes(room.roomId) }))} active={active} muted={muted ? rooms.map(room => room.roomId) : []} focus={focus} onSelect={setActive}/>
      <button className="channel-link" aria-label="Direct message"><span>Direct message</span><ReadStateBadges {...roomReadCounts(f.dm)} muted={muted} focus={focus}/></button>
      <textarea aria-label="Composer"/><MarkAllReadButton onMarkAllRead={() => void action.run()} busy={action.busy}/><KeyboardShortcuts userId={f.actor} currentRoomId={active} conversations={rooms.map(room => ({ id: room.roomId, unread: roomReadCounts(room).unread, muted }))} onSelectRoom={setActive} onMarkAllRead={() => void action.run()}/><Toaster/>
    </>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
