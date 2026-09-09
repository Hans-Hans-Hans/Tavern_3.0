import { createClient, MatrixEvent, Room } from 'matrix-js-sdk';

/** Real SDK room/member/account-data models; only the native network is a fixture. */
export function dmRequestsFixture() {
  const f = { account: {}, actor: '@bob:local', calls: [], listeners: new Set(), rooms: [], mapping: { '@existing:local': ['!existing:local'] }, failMap: false, failLeave: false, failJoin: false, deferJoin: false, beforeJoin: null, beforeGet: null, beforeBlock: null };
  const client = createClient({ baseUrl: 'https://matrix.example.test', userId: f.actor, accessToken: 'fixture', deviceId: 'BOB', timelineSupport: true }); f.client = client;
  f.emit = () => { for (const listener of f.listeners) listener(); };
  f.accountData = (type, content) => client.store.storeAccountDataEvents([new MatrixEvent({ type, content })]);
  f.accountData('m.direct', structuredClone(f.mapping));
  f.member = (room, membership, sender = '@alice:local', direct = true) => {
    const old = room.currentState.getStateEvents('m.room.member', f.actor);
    room.currentState.setStateEvents([new MatrixEvent({ event_id: '$' + membership + '-' + room.roomId + '-' + f.calls.length, room_id: room.roomId, type: 'm.room.member', state_key: f.actor, sender: membership === 'join' ? f.actor : sender, content: { membership, ...(membership === 'invite' ? { is_direct: direct } : {}) }, unsigned: old ? { prev_content: old.getContent(), prev_sender: old.getSender() } : {} })]);
    room.updateMyMembership(membership); f.emit();
  };
  f.add = (id = '!request:local', options = {}) => {
    const room = new Room(id, client, f.actor, { pendingEventOrdering: 'detached' });
    room.currentState.setStateEvents([
      new MatrixEvent({ type: 'm.room.create', state_key: '', room_id: id, sender: '@alice:local', content: { creator: '@alice:local', ...(options.type ? { type: options.type } : {}) } }),
      new MatrixEvent({ type: 'm.room.name', state_key: '', room_id: id, content: { name: options.name || 'Alice and friends' } }),
      new MatrixEvent({ type: 'm.room.member', state_key: '@alice:local', room_id: id, sender: '@alice:local', content: { membership: 'join', displayname: 'Alice' } }),
      new MatrixEvent({ type: 'm.room.join_rules', state_key: '', room_id: id, content: { join_rule: options.public ? 'public' : 'invite' } }),
      ...(options.plain ? [] : [new MatrixEvent({ type: 'm.room.encryption', state_key: '', room_id: id, content: { algorithm: 'm.megolm.v1.aes-sha2' } })]),
    ]);
    f.member(room, options.membership || 'invite', options.sender || '@alice:local', options.direct !== false);
    room.name = options.name || 'Alice and friends'; client.store.storeRoom(room); f.rooms.push(room); return room;
  };
  client.http.authedRequest = async (method, path, _query, body) => {
    f.calls.push({ method, path, body });
    if (path.startsWith('/join/')) {
      await f.beforeJoin?.(); if (f.failJoin) throw Object.assign(new Error('The native invitation is no longer valid.'), { errcode: 'M_FORBIDDEN' });
      const id = decodeURIComponent(path.slice('/join/'.length)), room = client.getRoom(id);
      if (!f.deferJoin) f.member(room, 'join'); return { room_id: id };
    }
    if (path.endsWith('/leave')) {
      if (f.failLeave) throw Object.assign(new Error('The homeserver could not confirm leaving.'), { errcode: 'M_FORBIDDEN' });
      f.member(client.getRoom(decodeURIComponent(path.split('/')[2])), 'leave'); return {};
    }
    if (path.includes('/account_data/')) {
      const type = decodeURIComponent(path.split('/account_data/')[1]);
      if (method === 'GET') { await f.beforeGet?.(); return type === 'm.direct' ? structuredClone(f.mapping) : client.getAccountData(type)?.getContent() || {}; }
      if (type === 'm.direct') { if (f.failMap) throw Object.assign(new Error('Messages list could not be saved.'), { errcode: 'M_FORBIDDEN' }); f.mapping = structuredClone(body); }
      f.accountData(type, body); f.emit(); return {};
    }
    throw new Error('Unexpected native request (no pre-accept history/media is permitted): ' + method + ' ' + path);
  };
  f.blockUser = async (id, blocked) => { f.calls.push({ method: 'BLOCK', path: id, body: blocked }); await f.beforeBlock?.(); await client.setIgnoredUsers(blocked ? [...new Set([...client.getIgnoredUsers(), id])] : client.getIgnoredUsers().filter(user => user !== id)); };
  f.room = f.add(); return f;
}
