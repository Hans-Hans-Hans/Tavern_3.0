import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ServerSystemMessagesSettings } from '../../../app/server-system-messages';
import { systemMessagesFixture } from '../../fixtures/server-system-messages.mjs';
import '../../../app/globals.css';

function Fixture() {
  const f = (window as any).systemFixture, [serverId, setServerId] = useState(f.server.roomId);
  f.showServer = setServerId;
  return <ServerSystemMessagesSettings serverId={serverId}/>;
}
export function mountFixture() {
  const w = window as any; w.systemFixture = systemMessagesFixture();
  if (new URLSearchParams(location.search).has('restricted')) w.systemFixture.actor = '@member:local';
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
