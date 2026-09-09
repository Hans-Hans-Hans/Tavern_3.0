import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServerCustomization } from '../../../app/community-settings';
import { RedeemInvite } from '../../../app/redeem-invite';
import { setAccountDevice } from '../../../lib/api';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any, query = new URLSearchParams(location.search); w.writes = []; w.uploads = []; w.listeners = [];
  const values: any[] = [], actor = query.has('restricted') ? '@member:local' : '@owner:local';
  const room: any = { roomId: '!server:local', name: 'Gaming', isSpaceRoom: () => true, getMyMembership: () => 'join', currentState: { maySendStateEvent: () => false, getStateEvents: (type: string, key?: string) => key === undefined ? values.filter(event => event.type === type) : values.find(event => event.type === type && event.state_key === key) || null } };
  room.put = (type: string, content: any, key = '') => {
    const index = values.findIndex(event => event.type === type && event.state_key === key), event = { type, content, state_key: key, event_id: '$' + type + ':' + w.writes.length, sender: '@owner:local', getContent: () => event.content, getStateKey: () => key, getSender: () => event.sender, getId: () => event.event_id };
    if (index >= 0) values.splice(index, 1, event); else values.push(event);
    return content;
  };
  room.put('m.room.create', { type: 'm.space', room_version: '11', 'm.federate': false });
  w.powers = room.put('m.room.power_levels', { users: { '@owner:local': 100, '@member:local': 100 }, events: {} });
  room.put('m.room.member', { membership: 'join' }, actor);
  room.put('m.room.name', { name: 'Gaming' });
  room.put('io.tavern.roles', { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: [] }], members: {}, overrides: {}, categoryOverrides: {} });
  room.put('io.tavern.server.branding', { banner: 'mxc://local/banner', welcome: 'Keep these welcome rules', accent: '#123456' });
  w.room = room;
  w.fixtureClient = query.has('invite') ? null : {
    getUserId: () => actor, getRoom: () => room, getRooms: () => [room], getHomeserverUrl: () => location.origin + '/api/matrix', getAccessToken: () => 'cookie-session:D1',
    mxcUrlToHttp: (mxc: string) => location.origin + '/_matrix/client/v1/media/thumbnail/' + mxc.slice(6),
    uploadContent: async (blob: Blob) => { w.uploads.push({ type: blob.type, size: blob.size }); return { content_uri: 'mxc://local/cropped-splash' }; },
    roomState: async () => { if (w.beforeRead) await w.beforeRead(); return values.map(({ type, state_key, content, sender, event_id }) => ({ type, state_key, content: structuredClone(content), sender, event_id })); },
    sendStateEvent: async (id: string, type: string, content: any, key: string) => { w.writes.push([id, type, content, key]); room.put(type, content, key); return { event_id: room.currentState.getStateEvents(type, key).getId() }; }
  };
  setAccountDevice('D1');
  const root = createRoot(document.getElementById('root')!); w.unmount = () => root.unmount();
  root.render(query.has('invite') ? <RedeemInvite onJoined={id => { w.joined = id; }}/> : <ServerCustomization serverId={room.roomId}/>);
}
