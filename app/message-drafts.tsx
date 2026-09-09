import { useSyncExternalStore } from 'react';
import { MessageCircle, ChevronRight } from 'lucide-react';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { createMessageDraftStore } from '@/lib/message-drafts';
import './message-drafts.css';

export const messageDrafts = createMessageDraftStore(() => {
  const client = getMatrixClient(), userId = client?.getUserId?.(), deviceId = client?.getDeviceId?.();
  return client && userId && deviceId ? { client, userId, deviceId, account: accountArtworkOwner() } : null;
});
let subscribers = 0, stop: (() => void) | undefined;
const subscribe = (listener: () => void) => {
  const off = messageDrafts.subscribe(listener);
  if (++subscribers === 1) {
    const matrix = onMatrixUpdate(messageDrafts.refresh);
    window.addEventListener('tavern:signout', messageDrafts.refresh);
    stop = () => { matrix(); window.removeEventListener('tavern:signout', messageDrafts.refresh); };
  }
  return () => { off(); if (--subscribers === 0) { stop?.(); stop = undefined; } };
};
export function useMessageDraft(roomId: string, parent?: string) {
  const owner = useSyncExternalStore(subscribe, messageDrafts.owner, () => null);
  const value = useSyncExternalStore(subscribe, () => messageDrafts.read(owner, roomId, parent));
  return { owner, value };
}
function useHasDraft(roomId: string, parent?: string) {
  return useSyncExternalStore(subscribe, () => !!messageDrafts.read(messageDrafts.owner(), roomId, parent).text.trim(), () => false);
}
export function DraftIndicator({ roomId, parent, label }: { roomId: string; parent?: string; label: string }) {
  return useHasDraft(roomId, parent) ? <span className='message-draft-badge' aria-label={label}>Draft</span> : null;
}
/** The first unsent reply must remain discoverable even before a thread exists. */
export function DraftThreadLink({ roomId, rootId, replies, onOpen }: { roomId: string; rootId: string; replies: number; onOpen: () => void }) {
  const draft = useHasDraft(roomId, rootId);
  if (!replies && !draft) return null;
  return <button className='thread-link' onClick={onOpen}><MessageCircle size={15}/>{replies > 0 && <>{replies} {replies === 1 ? 'reply' : 'replies'}</>}<span>View thread</span>{draft && <span className='message-draft-badge' aria-label='Draft reply'>Draft</span>}<ChevronRight size={13}/></button>;
}
