import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DmRequests } from '../../../app/dm-requests';
import { fixtureSetDmClient } from '../../../lib/matrix';
import { dmRequestsFixture } from '../../fixtures/dm-requests.mjs';
import '../../../app/globals.css';

function Fixture() {
  const [opened, setOpened] = useState('');
  return <><DmRequests onOpen={id => { (window as any).dmOpened.push(id); setOpened(id); }}/>{opened && <p>Opened conversation {opened}</p>}</>;
}
export function mountFixture() {
  const w = window as any; w.dmFixture = dmRequestsFixture(); w.dmOpened = []; fixtureSetDmClient(w.dmFixture.client);
  w.replaceDmOwner = () => { const old = w.dmFixture; w.dmFixture = dmRequestsFixture(); w.dmFixture.listeners = old.listeners; w.dmFixture.room.name = 'New account request'; fixtureSetDmClient(w.dmFixture.client); w.dmFixture.emit(); };
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
