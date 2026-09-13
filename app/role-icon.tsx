import { useEffect, useState } from 'react';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient } from '@/lib/matrix';
import { acquireCachedImage } from '@/lib/image-cache';
import type { ServerRole } from '@/lib/roles';
import './role-icon.css';

/** Authenticated, bounded artwork shared only by the current account/device. */
export function RoleIcon({ role, decorative = false }: { role: ServerRole; decorative?: boolean }) {
  const client = getMatrixClient(), account = accountArtworkOwner(), user = client?.getUserId(), device = client?.getDeviceId?.(), base = client?.getHomeserverUrl?.();
  const uri = role.iconMxc || '';
  const [loaded, setLoaded] = useState<{ uri: string; account: object; client: typeof client; user: typeof user; device: typeof device; base: typeof base; url: string } | null>(null);
  useEffect(() => {
    let active = true, release: (() => void) | undefined;
    const owns = () => !!client && accountArtworkOwner() === account && getMatrixClient() === client
      && client.getUserId() === user && client.getDeviceId?.() === device && client.getHomeserverUrl?.() === base;
    if (uri && owns()) void import('@/lib/community').then(({ profileImageBlob }) => {
      if (!active || !owns()) return;
      const lease = acquireCachedImage(account, JSON.stringify(['role-icon', base, user, device, uri]), signal => profileImageBlob(uri, 32, signal), owns);
      release = lease.release;
      return lease.promise.then(url => { if (active && owns()) setLoaded({ uri, account, client, user, device, base, url }); });
    }).catch(() => {});
    return () => { active = false; release?.(); };
  }, [uri, account, client, user, device, base]);
  if (!uri && !role.icon) return null;
  const src = loaded?.uri === uri && loaded.account === account && loaded.client === client
    && loaded.user === user && loaded.device === device && loaded.base === base ? loaded.url : '';
  return <span className='server-role-name-icon' role={decorative ? undefined : 'img'} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : role.name + ' role'} title={role.name}>
    {src ? <img src={src} width={16} height={16} alt='' onError={() => setLoaded(null)} /> : role.icon || '◆'}
  </span>;
}
