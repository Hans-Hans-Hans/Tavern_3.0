import { useEffect, useState } from 'react';
import { webhookAvatarUrl } from '@/lib/webhook-metadata';
import { accountArtworkOwner, fetchAccountArtwork } from '@/lib/api';
import { acquireCachedImage } from '@/lib/image-cache';

export function WebhookAvatar({ avatar, name }: { avatar: string; name: string }) {
  const [src, setSrc] = useState(''), url = webhookAvatarUrl(avatar), owner = accountArtworkOwner();
  useEffect(() => {
    let live = true; setSrc(''); if (!url) return;
    const lease = acquireCachedImage(owner, url, signal => fetchAccountArtwork(url, signal), () => accountArtworkOwner() === owner);
    lease.promise.then(value => { if (live) setSrc(value); }).catch(() => {});
    return () => { live = false; lease.release(); };
  }, [url, owner]);
  return src ? <img className='community-avatar' width={36} height={36} loading='lazy' src={src} alt={name + ' webhook avatar'} onError={() => setSrc('')}/>
    : <span className='community-avatar community-initials' style={{ width: 36, height: 36 }} aria-label={name + ' webhook'}>{name.slice(0, 2).toUpperCase()}</span>;
}

export function WebhookMessageLabel({ value }: { value?: { id: string; name: string; avatar: string } | null }) {
  return value ? <div className='webhook-message-label' title='This label is supplied by the message sender. The sender’s account is shown above.'><WebhookAvatar avatar={value.avatar} name={value.name}/><span><small>Webhook label</small><strong>{value.name}</strong></span></div> : null;
}
