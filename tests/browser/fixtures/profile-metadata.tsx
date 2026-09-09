import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setManagedAccount } from '../../../lib/api';
import { AccountCreationDate } from '../../../app/account-creation-date';
import { QuickProfile } from '../../../app/quick-profile';

function Fixture() {
  const [full, setFull] = useState(false), [userId, setUserId] = useState('@peer:local');
  return <><QuickProfile roomId='!shared:local' userId={userId} onOpenFull={() => setFull(true)}><button>Open quick profile</button></QuickProfile>
    {full && <><AccountCreationDate userId={userId} roomId='!shared:local'/><button onClick={() => setUserId('@remote:elsewhere')}>Show remote profile</button></>}
  </>;
}
export function mountFixture() { setManagedAccount(true); createRoot(document.getElementById('root')!).render(<Fixture/>); }
