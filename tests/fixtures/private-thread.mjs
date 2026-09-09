export function privateFixture() {
  const sourceId = '!source:test', serverId = '!server:test', privateId = '!private:test', author = '@author:test', member = '@member:test', other = '@other:test', owner = '@owner:test';
  const type = 'io.tavern.private_thread', settingsType = type + '.settings';
  const event = (type, state_key, content, sender = author, event_id = '$' + type + state_key) => ({ type, state_key, content, sender, event_id });
  const membership = user => event('m.room.member', user, { membership: 'join', displayname: { [author]: 'Alice', [member]: 'Bob', [other]: 'Charlie', [owner]: 'Owner' }[user] });
  const policy = { version: 1, owner, roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages', 'create_private_threads', 'invite'] }, { id: 'mod', name: 'Moderator', position: 50, permissions: ['kick', 'ban', 'manage_messages'] }], members: { [author]: ['mod'] }, overrides: {}, categoryOverrides: {} };
  const states = new Map([
    [sourceId, [event('m.room.create', '', { 'm.federate': false }), event('m.room.encryption', '', { algorithm: 'm.megolm.v1.aes-sha2' }), event('m.space.parent', serverId, { canonical: true, via: ['test'] }), event('m.room.power_levels', '', { users: { [author]: 50, [owner]: 100 }, invite: 0 }), ...[author, member, other, owner].map(membership)]],
    [serverId, [event('m.room.create', '', { type: 'm.space', 'm.federate': false }, owner), event('io.tavern.roles', '', policy), event('m.space.child', sourceId, { via: ['test'] }), event('m.room.power_levels', '', { users: { [author]: 50, [owner]: 100 } }), ...[author, member, other, owner].map(membership)]],
  ]);
  const writes = [], listeners = new Set(), rooms = new Map(), messages = new Map(), fixture = { sourceId, serverId, privateId, author, member, other, owner, policy, states, writes, listeners, actor: author, stateTransform: value => value };
  const notify = () => listeners.forEach(listener => listener());
  const wrap = raw => raw && ({ getContent: () => raw.content, getSender: () => raw.sender, getId: () => raw.event_id, getStateKey: () => raw.state_key, getType: () => raw.type, getTs: () => raw.created_at || Date.now() });
  const members = roomId => (states.get(roomId) || []).filter(e => e.type === 'm.room.member').map(e => ({ userId: e.state_key, name: e.content.displayname || e.state_key, membership: e.content.membership, powerLevel: states.get(roomId).find(e => e.type === 'm.room.power_levels')?.content.users?.[e.state_key] || 0 }));
  function room(roomId) {
    if (!states.has(roomId)) return null;
    if (!rooms.has(roomId)) rooms.set(roomId, { roomId, name: roomId === sourceId ? 'Source channel' : roomId === serverId ? 'Test server' : 'Private help', isSpaceRoom: () => roomId === serverId, getMyMembership: () => members(roomId).find(member => member.userId === fixture.actor)?.membership || 'leave', getMember: user => members(roomId).find(member => member.userId === user), getMembers: () => members(roomId), getJoinedMembers: () => members(roomId).filter(member => member.membership === 'join'), loadMembersIfNeeded: async () => {}, getLiveTimeline: () => ({ getEvents: () => (messages.get(roomId) || []).map(raw => wrap({ ...raw, type: 'm.room.message' })) }), currentState: { getStateEvents: (type, key) => key === undefined ? states.get(roomId).filter(e => e.type === type).map(wrap) : wrap(states.get(roomId).find(e => e.type === type && e.state_key === key)), maySendStateEvent: (type, actor) => { const powers = states.get(roomId).find(e => e.type === 'm.room.power_levels')?.content || {}; return (powers.users?.[actor] || 0) >= (powers.events?.[type] ?? powers.state_default ?? 50); } } });
    return rooms.get(roomId);
  }
  function seedPrivate(roomId = privateId, invited = []) {
    states.set(roomId, [event('m.room.create', '', { type, 'm.federate': false, [type]: { version: 1, source_room_id: sourceId, source_event_id: '$root' } }), event('m.room.encryption', '', { algorithm: 'm.megolm.v1.aes-sha2' }), event('m.room.history_visibility', '', { history_visibility: 'joined' }), event('m.room.power_levels', '', { users: { [author]: 100 }, events: { [settingsType]: 50 }, invite: 0 }), event(settingsType, '', { version: 1, title: 'Private help', archived: false, autoArchiveSeconds: 0, activityStartedAt: Date.now() }, author, '$settings'), ...[author, member].filter(user => !invited.includes(user)).map(membership), ...invited.map(user => event('m.room.member', user, { membership: 'invite', displayname: user }))]);
    messages.set(roomId, [{ id: '$hello', body: 'Existing private message', author_id: author, author_name: 'Alice', created_at: Date.now(), conversation_id: roomId, attachments: [] }]);
  }
  seedPrivate();
  const client = {
    getUserId: () => fixture.actor, getRoom: room, getRooms: () => [...states.keys()].map(room), roomState: async id => fixture.stateTransform(structuredClone(states.get(id) || []), id),
    getAccountData: () => null, getAccountDataFromServer: async () => null, setAccountData: async () => {},
    fetchRoomEvent: async (roomId, eventId) => ({ room_id: roomId, event_id: eventId, type: 'm.room.encrypted' }),
    createRoom: async request => { writes.push({ action: 'create', request }); const id = '!created:test'; seedPrivate(id, request.invite); const state = states.get(id); state.find(e => e.type === 'm.room.create').content = request.creation_content; state.find(e => e.type === settingsType).content = { ...request.initial_state.find(e => e.type === settingsType).content, activityStartedAt: Date.now() }; notify(); return { room_id: id }; },
    sendStateEvent: async (roomId, type, content, key) => { writes.push({ action: 'state', roomId, type, content, key }); const state = states.get(roomId), previous = state.findIndex(e => e.type === type && e.state_key === key), next = event(type, key, content, fixture.actor, '$saved' + writes.length); if (previous >= 0) state.splice(previous, 1, next); else state.push(next); notify(); return { event_id: next.event_id }; },
    invite: async (roomId, userId) => { writes.push({ action: 'invite', roomId, userId }); states.get(roomId).push(event('m.room.member', userId, { membership: 'invite', displayname: userId })); notify(); },
    kick: async (roomId, userId) => { writes.push({ action: 'kick', roomId, userId }); states.get(roomId).find(e => e.type === 'm.room.member' && e.state_key === userId).content.membership = 'leave'; notify(); },
    ban: async (roomId, userId) => { writes.push({ action: 'ban', roomId, userId }); notify(); },
    leave: async roomId => { writes.push({ action: 'leave', roomId }); states.get(roomId).find(e => e.type === 'm.room.member' && e.state_key === fixture.actor).content.membership = 'leave'; notify(); },
    joinRoom: async roomId => { writes.push({ action: 'join', roomId }); states.get(roomId).find(e => e.type === 'm.room.member' && e.state_key === fixture.actor).content.membership = 'join'; notify(); return room(roomId); },
    sendMessage: async (roomId, content, transactionId) => { writes.push({ action: 'send', roomId, content, transactionId }); messages.get(roomId).push({ id: '$sent' + writes.length, body: content.body, author_id: fixture.actor, author_name: 'Alice', created_at: Date.now(), conversation_id: roomId, attachments: [] }); notify(); return { event_id: '$sent' + writes.length }; },
  };
  const matrixApi = async (action, value, params) => action === 'messages' ? { messages: [...(messages.get(params.conversation) || [])], hasMore: false } : { ok: true };
  return Object.assign(fixture, { client, matrixApi, messages, notify, seedPrivate, event });
}
