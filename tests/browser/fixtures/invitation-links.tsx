import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InviteManager } from '../../../app/invitations';
import { RedeemInvite } from '../../../app/redeem-invite';
import '../../../app/globals.css';

export function mountFixture() {
  function Fixture() {
    const [room, setRoom] = useState('!guild:test');
    (window as any).switchInviteRoom = setRoom;
    return <main style={{ maxWidth: 700, padding: 12 }}>{(window as any).inviteMode === 'redeem'
      ? <RedeemInvite onJoined={id => (window as any).joinedInvites.push(id)}/>
      : <InviteManager roomId={room}/>}</main>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
