import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServerProfilePolicySettings } from '../../../app/server-profile-policy';
import { profileMetadataFixture } from '../../fixtures/profile-metadata.mjs';
import '../../../app/globals.css';

export function mountFixture() {
  const w = window as any; w.profileFixture = profileMetadataFixture();
  if (new URLSearchParams(location.search).has('restricted')) w.profileFixture.actor = '@member:local';
  createRoot(document.getElementById('root')!).render(<ServerProfilePolicySettings serverId={w.profileFixture.server.roomId}/>);
}
