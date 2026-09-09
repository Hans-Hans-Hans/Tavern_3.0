import { MatrixEvent, Room } from 'matrix-js-sdk';
import { mountFixture as mountWorkspace } from './private-workspace';
import { setAccountDevice } from '../../../lib/api';
import { navigationAccountKey } from '../../../lib/read-state';

export function mountFixture() {
  mountWorkspace();
  const w = window as any, client = w.client, actor = client.getUserId();
  setAccountDevice('D1');
  const id = '!dm:local', room = new Room(id, client, actor, { pendingEventOrdering: 'detached' } as any);
  room.currentState.setStateEvents([
    ['m.room.create', '', { creator: actor, room_version: '11', 'm.federate': false }],
    ['m.room.member', actor, { membership: 'join', displayname: 'Owner' }],
    ['m.room.member', '@guest:local', { membership: 'join', displayname: 'Guest' }],
    ['m.room.power_levels', '', { users: { [actor]: 100 } }],
    ['m.room.encryption', '', { algorithm: 'm.megolm.v1.aes-sha2' }],
  ].map(([type, state_key, content]) => new MatrixEvent({ type, state_key, content, room_id: id, event_id: '$dm' + type + state_key, sender: actor } as any)));
  room.name = 'Guest'; room.updateMyMembership('join'); room.loadMembersIfNeeded = async () => {};
  w.rooms.set(id, room);
  if (new URLSearchParams(location.search).has('forum')) {
    w.source.currentState.setStateEvents([new MatrixEvent({ type: 'io.tavern.channel', state_key: '', content: { version: 1, kind: 'forum' }, room_id: w.source.roomId, event_id: '$forum-settings', sender: actor })]);
    w.publicMessage.forum = { title: 'Draft forum topic', tags: [] };
  }
  const account = client.getAccountData.bind(client);
  client.getAccountData = (type: string) => type === navigationAccountKey ? new MatrixEvent({ type, content: { favorites: ['!source:local', id], unread: [] } }) : account(type);
  const original = w.matrixBoundary;
  w.sent = []; w.pendingSends = [];
  w.matrixBoundary = (name: string, args: any[]) => {
    if (name === 'matrixApi' && args[0] === 'bootstrap') return original(name, args).then((value: any) => ({ ...value, members: [...value.members, {id:'@guest:local',name:'Guest',role:'member'}], memberships: [{conversation_id:id,user_id:actor},{conversation_id:id,user_id:'@guest:local'}], conversations: value.conversations.map((item: any) => item.id === id ? { ...item, kind: 'dm', name: 'Guest' } : item) }));
    if (name === 'matrixApi' && args[0] === 'send') {
      w.sent.push(structuredClone(args[1]));
      if (w.rejectSend) return Promise.reject(new Error('Fixture send was not acknowledged'));
      if (w.deferSend) return new Promise((resolve, reject) => w.pendingSends.push({ resolve: () => resolve({ ok: true }), reject }));
      return Promise.resolve({ ok: true });
    }
    return original(name, args);
  };
  w.replaceAccount = () => { setAccountDevice('TEMP'); setAccountDevice('D1'); w.notify(); };
}
