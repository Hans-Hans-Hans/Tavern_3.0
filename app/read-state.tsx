import { useEffect, useRef, useState } from 'react';
import { CheckCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient } from '@/lib/matrix';
import { markReadSummary, type MarkReadResult } from '@/lib/read-state';
import './read-state.css';

export function ReadStateBadges({ unread, mentions = 0, manual = false, muted = false, focus = false }: { unread: number; mentions?: number; manual?: boolean; muted?: boolean; focus?: boolean }) {
  if (muted || focus) return null;
  const total = Number.isSafeInteger(unread) && unread > 0 ? unread : 0, highlight = Number.isSafeInteger(mentions) && mentions > 0 ? mentions : 0;
  const label = (n: number) => n > 99 ? '99+' : String(n);
  return <span className="read-state-badges">{total > 0 && <span className="unread-count" role="img" aria-label={`${total} unread notifications`} title="Unread notifications, including highlighted notifications">{label(total)}</span>}{highlight > 0 && <span className="mention-count" role="img" aria-label={`${highlight} unread mentions and highlights`} title="Matrix mentions and keyword highlights. This count overlaps the unread total.">@{label(highlight)}</span>}{manual && !total && <span className="manual-unread" role="img" aria-label="Manually marked unread" title="Manually marked unread"/>}</span>;
}

/** Bind visible actions and their results to the same client, actor and API generation. */
export function useMarkReadAction(mark: (rooms?: readonly string[]) => Promise<MarkReadResult>) {
  const client = getMatrixClient(), actor = client?.getUserId(), generation = accountArtworkOwner();
  const live = useRef(true), pending = useRef<object | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { pending.current = null; setBusy(false); }, [client, actor, generation]);
  const current = () => live.current && !!client && getMatrixClient() === client && client.getUserId() === actor && accountArtworkOwner() === generation;
  const run = async (rooms?: readonly string[]) => {
    if (!current() || pending.current) return;
    const operation = {}; pending.current = operation; setBusy(true);
    try {
      const result = await mark(rooms); if (!current() || pending.current !== operation) return;
      const message = markReadSummary(result); if (result.failed.length || result.markerError) toast.error(message); else toast(message);
    } catch (error) { if (current() && pending.current === operation) toast.error(error instanceof Error ? error.message : 'Read state could not be updated.'); }
    finally { if (current() && pending.current === operation) { pending.current = null; setBusy(false); } }
  };
  return { run, busy, available: !!client };
}
export function MarkAllReadButton({ onMarkAllRead, busy, disabled = false }: { onMarkAllRead: () => void; busy: boolean; disabled?: boolean }) {
  return <button type="button" className="mark-all-read" disabled={disabled || busy} onClick={onMarkAllRead} title="Mark joined conversations read through their currently loaded events. Alt + Shift + R.">{busy ? <Loader2 size={16} className="spin"/> : <CheckCheck size={16}/>}<span>{busy ? 'Marking conversations read…' : 'Mark all read'}</span></button>;
}
