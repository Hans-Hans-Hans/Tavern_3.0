import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RoomReportReview } from '../../../app/room-report-review';
import { ReportDialog, type ReportTarget } from '../../../app/report-dialog';
import { setManagedAccount } from '../../../lib/api';
import '../../../app/globals.css';

const report: ReportTarget = { kind: 'message', roomId: '!room:local', eventId: '$event', targetId: '@member:local' };
function Submission() { const [target, setTarget] = useState<ReportTarget | null>(report); return <><button onClick={() => setTarget(report)}>Report another message</button><ReportDialog target={target} onClose={() => setTarget(null)}/></>; }
export function mountFixture() {
  const w = window as any;
  const role = { version: 1, owner: '@owner:local', roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: [], color: '', icon: '' }, { id: 'moderator', name: 'Moderator', position: 50, permissions: ['manage_reports'], color: '', icon: '' }], members: { '@mod:local': ['moderator'] }, overrides: {}, categoryOverrides: {} };
  const roleEvent = { getContent: () => role }, parentEvent = { getStateKey: () => '!server:local', getContent: () => ({ canonical: true, via: ['local'] }) }, childEvent = { getStateKey: () => '!room:local', getContent: () => ({ via: ['local'] }) };
  const state = (isServer: boolean) => ({ hasSufficientPowerLevelFor: () => true, getStateEvents: (type: string, key?: string) => {
    if (key === undefined) return type === 'm.space.child' && isServer ? [childEvent] : type === 'm.space.parent' && !isServer ? [parentEvent] : [];
    if (type === 'io.tavern.roles' && isServer) return roleEvent;
    if (type === 'm.space.child' && isServer) return childEvent;
    if (type === 'm.space.parent' && !isServer) return parentEvent;
    return null;
  } });
  const server = { roomId: '!server:local', name: 'Community', getMyMembership: () => 'join', getMember: () => ({ powerLevel: 50 }), isSpaceRoom: () => true, currentState: state(true) };
  const room = { roomId: '!room:local', name: 'General', getMyMembership: () => 'join', getMember: () => ({ powerLevel: 50 }), isSpaceRoom: () => false, currentState: state(false) };
  w.fixtureClient = { getUserId: () => '@mod:local', getRoom: (id: string) => id === '!server:local' ? server : id === '!room:local' ? room : null };
  setManagedAccount(true);
  createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('submit') ? <Submission/> : <RoomReportReview roomId='!room:local'/>);
}
