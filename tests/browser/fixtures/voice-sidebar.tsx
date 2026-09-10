import React from 'react';
import { createRoot } from 'react-dom/client';
import { mountFixture as mountVoice } from './voice-channel';
import { VoiceSidebarDock, VoiceSidebarParticipants } from '../../../app/voice-sidebar';
import { onParticipantNavigation } from '../../../lib/participant-navigation';

export function mountFixture() {
  mountVoice();
  const f = (window as any).voiceFixture;
  const aside = document.createElement('aside'); aside.setAttribute('aria-label', 'Voice channel sidebar');
  aside.style.cssText = 'display:flex;flex-direction:column;width:280px;max-width:100%;height:520px;background:var(--card);border:1px solid var(--border)';
  document.body.prepend(aside);
  onParticipantNavigation(value => f.profiles.push(value.userId));
  f.expire = (roomId: string, userId: string) => {
    const session = f.sessions.get(roomId); session.memberships.forEach((member: any) => { if (member.userId === userId) member.isExpired = () => true; });
    session.listeners.forEach((listener: () => void) => listener());
  };
  f.replaceDevice = (from: string, to: string) => {
    const session = f.sessions.get('!voice:local'); session.memberships.forEach((member: any) => { if (member.deviceId === from) member.deviceId = to; });
    session.listeners.forEach((listener: () => void) => listener());
  };
  createRoot(aside).render(<><div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
    <h3 style={{ fontSize: 13, padding: '8px 14px' }}>Voice lounge</h3><VoiceSidebarParticipants roomId="!voice:local"/>
    <h3 style={{ fontSize: 13, padding: '8px 14px' }}>Other lounge</h3><VoiceSidebarParticipants roomId="!other:local"/>
  </div><VoiceSidebarDock onSelect={id => { f.selected = id; f.render(id); }}/></>);
}
