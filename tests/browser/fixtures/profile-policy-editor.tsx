import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProfileSettings } from '../../../app/community-settings';
import { normalizeProfile } from '../../../lib/community';
import { profileMetadataFixture } from '../../fixtures/profile-metadata.mjs';
import '../../../app/globals.css';

function Fixture() {
  const f = (window as any).profileFixture;
  const [serverId, setServerId] = useState<string | undefined>(new URLSearchParams(location.search).has('global') ? undefined : f.server.roomId);
  f.showServer = setServerId;
  return <ProfileSettings serverId={serverId} onChanged={async () => { f.changed++; await f.afterChanged?.(); }}/>;
}
export function mountFixture() {
  const w = window as any, f = w.profileFixture = profileMetadataFixture(); f.changed = 0;
  f.originalProfile = normalizeProfile({ name: 'Chosen server name', bio: 'Original bio '.repeat(30), status: 'Original long status '.repeat(5), statusEmoji: '🙂', links: [{ label: 'Homepage', url: 'https://example.com' }], fields: [{ label: 'Office', value: 'Remote' }] });
  f.globalProfile = normalizeProfile({ ...f.originalProfile, name: 'Full global name', bio: 'Global biography '.repeat(40), status: 'Global status '.repeat(8) });
  f.account = structuredClone(f.globalProfile);
  f.server.put('m.room.member', { membership: 'join', displayname: f.originalProfile.name, 'io.tavern.profile': { ...f.originalProfile, serverOverride: f.server.roomId } }, f.actor);
  f.server.put('io.tavern.server.profile_policy', { version: 1, enabled: true, allowLinks: false, allowCustomFields: false, maxBioLength: 160, maxStatusLength: 40 });
  f.second = f.room('!second:local', 'm.space');
  f.second.put('m.room.member', { membership: 'join', displayname: 'Second server profile', 'io.tavern.profile': normalizeProfile({ name: 'Second server profile', bio: 'Second bio' }) }, f.actor);
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
