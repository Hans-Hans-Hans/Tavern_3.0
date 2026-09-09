export function profileMetadataFixture() {
  const f = { actor: '@owner:local', rooms: new Map(), writes: [], reads: [], listeners: new Set(), beforeRead: null, beforeWrite: null, rejectWrite: false, account: {}, native: {} };
  f.room = (id, type) => {
    const values = [];
    const room = { roomId: id, name: id, membership: 'join', isSpaceRoom: () => type === 'm.space', getMyMembership: () => room.membership,
      getMember: user => ({ name: user, membership: room.currentState.getStateEvents('m.room.member', user)?.content.membership }),
      currentState: { getStateEvents: (kind, key) => key === undefined ? values.filter(value => value.type === kind) : values.find(value => value.type === kind && value.state_key === key) || null },
      state: () => values.map(({ type, content, state_key, event_id, sender }) => ({ type, content: structuredClone(content), state_key, event_id, sender })),
      put: (kind, content, key = '') => {
        if (kind === 'io.tavern.server.profile_policy' && content.version === 1) content = { 'io.tavern.previous_event': null, ...content };
        const value = { type: kind, state_key: key, content, sender: '@owner:local', event_id: '$state-' + (++f.revision) + '-' + kind,
          getContent: () => value.content, getStateKey: () => key, getSender: () => value.sender, getId: () => value.event_id };
        const index = values.findIndex(item => item.type === kind && item.state_key === key); if (index < 0) values.push(value); else values.splice(index, 1, value); return value;
      },
    };
    room.put('m.room.create', { ...(type ? { type } : {}), 'm.federate': false, room_version: '11' });
    room.put('m.room.power_levels', { users: { '@owner:local': 100, '@member:local': 100 }, events: {} });
    for (const actor of ['@owner:local', '@member:local']) room.put('m.room.member', { membership: 'join', displayname: actor, third_party_invite: { signed: 'preserved' } }, actor);
    f.rooms.set(id, room); return room;
  };
  f.revision = 0;
  f.server = f.room('!server:local', 'm.space');
  f.server.put('io.tavern.roles', { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages'] }], members: {}, overrides: {}, categoryOverrides: {} });
  f.channel = f.room('!channel:local');
  f.channel.put('m.space.parent', { canonical: true, via: ['local'] }, f.server.roomId); f.server.put('m.space.child', { via: ['local'] }, f.channel.roomId);
  f.private = f.room('!private:local', 'io.tavern.private_thread');
  f.private.put('m.room.create', { type: 'io.tavern.private_thread', 'm.federate': false, 'io.tavern.private_thread': { version: 1, source_room_id: f.channel.roomId, source_event_id: '' } });
  f.client = {
    getUserId: () => f.actor, getRoom: id => f.rooms.get(id), getRooms: () => [...f.rooms.values()], getUser: () => ({ displayName: 'Global owner', avatarUrl: '' }),
    getAccountData: () => ({ getContent: () => f.account }),
    setDisplayName: async name => { f.native.name = name; await f.afterDisplayName?.(); }, setAvatarUrl: async avatar => { f.native.avatar = avatar; }, setAccountData: async (_, data) => { f.account = structuredClone(data); },
    roomState: async id => { f.reads.push(id); await f.beforeRead?.(id); const room = f.rooms.get(id); if (!room) throw new Error('Server is unavailable.'); return room.state(); },
    sendStateEvent: async (...args) => { await f.beforeWrite?.(...args); if (f.rejectWrite) throw new Error('The server rejected these profile rules.'); f.writes.push(args); const value = f.rooms.get(args[0]).put(args[1], structuredClone(args[2]), args[3]); for (const listener of f.listeners) listener(); return { event_id: value.event_id }; },
  };
  return f;
}
