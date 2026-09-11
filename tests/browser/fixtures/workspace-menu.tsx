import React from 'react';
import { createRoot } from 'react-dom/client';
import { MatrixEvent, RoomState } from 'matrix-js-sdk';
import * as icons from 'lucide-react';
import '../../../app/globals.css';

export async function mountFixture() {
  const roomId = '!ciWorkspaceHash', actor = '@cialice:chat.example.test';
  const state = new RoomState(roomId);
  const event = (type: string, content: object, state_key = '') => new MatrixEvent({
    type, content, state_key, room_id: roomId, sender: actor, event_id: '$' + type,
  });
  state.setStateEvents([
    event('m.room.create', { room_version: '12', type: 'm.space', 'm.federate': false }),
    event('m.room.power_levels', { users: {}, users_default: 0, state_default: 50 }),
    event('m.room.member', { membership: 'join' }, actor),
    event('m.room.member', { membership: 'join' }, '@cibob:chat.example.test'),
  ]);
  const room = { currentState: state, getMyMembership: () => 'join', isSpaceRoom: () => true };
  (window as any).workspaceFixture = {
    React, icons, actor, state, room,
    client: { getUserId: () => actor, getRoom: (id: string) => id === roomId ? room : null },
    server: { id: roomId, name: 'CI system notices test server' },
  };
  const path = '/workspace-menu-boundary.js';
  const { WorkspaceMenu } = await import(/* @vite-ignore */ path);
  createRoot(document.getElementById('root')!).render(<WorkspaceMenu />);
}
