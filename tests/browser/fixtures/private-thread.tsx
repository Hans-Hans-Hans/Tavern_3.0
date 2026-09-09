import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivateThreadLauncher, PrivateThreadPanel } from '../../../app/private-thread';
import { privateFixture } from '../../fixtures/private-thread.mjs';
import '../../../app/globals.css';
export function mountFixture() {
  const w = window as any, fixture = privateFixture();
  w.fixture = fixture; w.fixtureClient = fixture.client; w.listeners = fixture.listeners; w.matrixApi = fixture.matrixApi;
  function Fixture() { const [roomId, setRoomId] = useState(''); return <main style={{ display: 'flex', height: '95vh' }}><section style={{ flex: 1 }}><h1>Source channel stays open</h1><p>A source message that must never be copied</p><PrivateThreadLauncher sourceRoomId={fixture.sourceId} sourceEventId='$root' onOpen={setRoomId}/><button onClick={() => setRoomId(fixture.privateId)}>Open existing private discussion</button></section>{roomId && <PrivateThreadPanel key={roomId} roomId={roomId} onClose={() => setRoomId('')}/>}</main>; }
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
