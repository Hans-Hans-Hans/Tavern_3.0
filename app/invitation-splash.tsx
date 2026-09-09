import { useEffect, useState } from 'react';
import { accountArtworkOwner, fetchAccountArtwork } from '@/lib/api';
import { acquireCachedImage } from '@/lib/image-cache';
import { invitationSplashUrl } from '@/lib/invitation-artwork';

export function InvitationSplash({ mxc }: { mxc: string }) {
  const [src, setSrc] = useState(''), url = invitationSplashUrl(mxc), owner = accountArtworkOwner();
  useEffect(() => {
    let live = true; setSrc(''); if (!url) return;
    const lease = acquireCachedImage(owner, url, signal => fetchAccountArtwork(url, signal), () => accountArtworkOwner() === owner);
    lease.promise.then(value => { if (live) setSrc(value); }).catch(() => {});
    return () => { live = false; lease.release(); };
  }, [url, owner]);
  return src ? <img className='community-banner' width={1200} height={400} src={src} alt='Invitation artwork' onError={() => setSrc('')}/> : null;
}
