import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';

/** An editor belongs to one account, SDK device, room and mounted scope. */
export function useRoleEditorOwner(serverId: string, target = '') {
  const [owner] = useState(() => {
    const client = getMatrixClient();
    return { client, account: accountArtworkOwner(), user: client?.getUserId(), device: client?.getDeviceId?.(), room: client?.getRoom(serverId), serverId, target };
  });
  const alive = useRef(true), [, redraw] = useState(0);
  const current = () => !!(alive.current && owner.client && owner.user && owner.room
    && owner.serverId === serverId && owner.target === target && owner.client === getMatrixClient()
    && owner.account === accountArtworkOwner() && owner.user === owner.client.getUserId()
    && owner.device === owner.client.getDeviceId?.() && owner.room === owner.client.getRoom(serverId)
    && owner.room.getMyMembership() === 'join');
  useEffect(() => {
    alive.current = true;
    const off = onMatrixUpdate(() => redraw(value => value + 1));
    const timer = setInterval(() => { if (!current()) redraw(value => value + 1); }, 250);
    return () => { alive.current = false; clearInterval(timer); off(); };
  }, [owner]);
  return { current, client: owner.client, user: owner.user || '' };
}
