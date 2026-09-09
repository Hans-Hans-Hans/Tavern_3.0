import { useEffect, useState } from 'react';
import { isManagedAccount, requestApi } from '@/lib/api';

/** Mounted in full profiles/settings only; lightweight profile popovers do not fetch. */
export function AccountCreationDate({ userId, roomId }: { userId: string; roomId?: string }) {
  const [value, setValue] = useState<number | null>(null), [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true; setValue(null); setLoading(false);
    if (!userId || !isManagedAccount()) return;
    setLoading(true);
    void requestApi<{ createdAt: number | null }>('/profiles/' + encodeURIComponent(userId) + '/account' + (roomId ? '?roomId=' + encodeURIComponent(roomId) : '')).then(result => {
      if (live) setValue(typeof result.createdAt === 'number' && Number.isFinite(result.createdAt) ? result.createdAt : null);
    }).catch(() => {}).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [userId, roomId]);
  return <p>Account created: {loading ? 'Loading…' : value ? <time dateTime={new Date(value).toISOString()}>{new Date(value).toLocaleDateString()}</time> : 'Unavailable'}</p>;
}
