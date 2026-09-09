import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { isManagedAccount } from '@/lib/api';
import { startActivityNotifications, type ActivitySignal } from '@/lib/activity-notifications';
import { browserNotificationsEnabled, playNotificationSound } from '@/lib/notifications';

/** Mounted once; calls remain in the existing call panel and Contacts handles requests. */
export function ActivityNotifications({ onOpenContacts }: { onOpenContacts: () => void }) {
  const openContacts = useRef(onOpenContacts); openContacts.current = onOpenContacts;
  useEffect(() => {
    let owner = getMatrixClient(), managed = isManagedAccount(), signedOutOwner: typeof owner = null, session: ReturnType<typeof startActivityNotifications> | null = null;
    const deliver = (signal: ActivitySignal, options: { sound: boolean }) => {
      const text = signal.kind === 'friend' ? 'You have a new friend request.' : 'You have an incoming call.';
      let notice: Notification | null = null;
      const id = 'tavern-activity:' + signal.id;
      const open = () => {
        window.focus();
        if (signal.kind === 'friend') openContacts.current();
        else {
          document.querySelector<HTMLButtonElement>('[aria-label="Active call"] button[aria-label="Expand call"]')?.click();
          document.querySelector<HTMLElement>('[aria-label="Active call"] button')?.focus();
        }
        notice?.close(); toast.dismiss(id);
      };
      // No names, account IDs, room names, call metadata or message bodies leave the page.
      if (document.visibilityState === 'hidden' && browserNotificationsEnabled()) {
        try { notice = new Notification('Tavern', { body: text, tag: 'tavern:' + signal.kind, silent: true }); notice.onclick = open; } catch { /* The in-app notice remains available if browser delivery is unavailable. */ }
      }
      toast(text, { id, duration: signal.kind === 'call' ? Infinity : 8000, action: { label: signal.kind === 'friend' ? 'View requests' : 'Show call', onClick: open } });
      if (options.sound) void playNotificationSound().catch(() => {});
      return () => { if (notice) { notice.onclick = null; notice.close(); } toast.dismiss(id); };
    };
    const errorId = 'tavern-friend-alert-error';
    const start = () => {
      if (owner) session = startActivityNotifications(owner, deliver, message => { if (message) toast.error(message, { id: errorId, action: { label: 'Contacts', onClick: () => openContacts.current() } }); else toast.dismiss(errorId); });
    };
    const update = () => {
      const next = getMatrixClient(), nextManaged = isManagedAccount();
      if (next && next === signedOutOwner) return;
      if (next !== owner || nextManaged !== managed) { session?.stop(); session = null; toast.dismiss(errorId); owner = next; managed = nextManaged; start(); }
      else session?.recheck();
    };
    const signout = () => { signedOutOwner = owner; session?.stop(); session = null; owner = null; toast.dismiss(errorId); };
    start(); const unsubscribe = onMatrixUpdate(update);
    window.addEventListener('tavern:signout', signout);
    return () => { unsubscribe(); window.removeEventListener('tavern:signout', signout); session?.stop(); toast.dismiss(errorId); };
  }, []);
  return null;
}
