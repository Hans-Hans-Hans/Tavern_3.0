import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { getMatrixClient, matrixApi } from '@/lib/matrix';
import { CommunityImage } from './community-settings';
import type { Reaction } from '@/lib/message-projection';

export function ReactionBar({ roomId, eventId, reactions, canReact, onProfile }: { roomId: string; eventId: string; reactions: Reaction[]; canReact: boolean; onProfile: (id: string) => void }) {
  const [pending, setPending] = useState<Record<string, boolean>>({}), busy = useRef(new Set<string>()), timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const me = getMatrixClient()?.getUserId() || '';
  useEffect(() => { setPending(old => Object.fromEntries(Object.entries(old).filter(([emoji, desired]) => Boolean(reactions.find(r => r.emoji === emoji)?.mine) !== desired))); }, [reactions]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  async function toggle(reaction: Reaction) {
    if (!canReact || busy.current.has(reaction.emoji) || reaction.emoji in pending) return;
    const emoji = reaction.emoji; busy.current.add(emoji); setPending(old => ({ ...old, [emoji]: !reaction.mine }));
    try { await matrixApi('react', { id: eventId, emoji }); timers.current.set(emoji, setTimeout(() => { setPending(old => { const next = { ...old }; delete next[emoji]; return next; }); timers.current.delete(emoji); }, 15000)); }
    catch (error) { setPending(old => { const next = { ...old }; delete next[emoji]; return next; }); toast.error((error as Error).message || 'Your reaction could not be saved.'); }
    finally { busy.current.delete(emoji); }
  }
  if (!reactions.length) return null;
  return <div className="reaction-row">{reactions.map(reaction => {
    const mine = reaction.emoji in pending ? pending[reaction.emoji] : !!reaction.mine;
    const users = [...new Set([...(reaction.users || []).filter(id => id !== me), ...(mine && me ? [me] : [])])];
    const count = Math.max(0, reaction.count + Number(mine) - Number(!!reaction.mine));
    const emoji = reaction.emoji.startsWith('mxc://') ? 'Custom emoji' : reaction.emoji;
    return <span className={'reaction-group ' + (mine ? 'selected' : '')} key={reaction.emoji}>
      <button type="button" className="reaction-toggle" aria-label={`${mine ? 'Remove' : 'Add'} ${emoji} reaction`} aria-pressed={mine} aria-busy={reaction.emoji in pending} disabled={!canReact || reaction.emoji in pending} onClick={() => void toggle(reaction)}>{reaction.emoji.startsWith('mxc://') ? <CommunityImage mxc={reaction.emoji} name={emoji} size={22} /> : reaction.emoji}</button>
      <Popover><PopoverTrigger asChild><button type="button" className="reaction-count" aria-label={`View ${count} people reacting with ${emoji}`}>{count}</button></PopoverTrigger><PopoverContent className="reaction-members"><strong>Reacted with {emoji}</strong><p>People in the loaded reaction history</p><div>{users.slice(0, 100).map(id => <button type="button" key={id} aria-label={'View ' + (getMatrixClient()?.getRoom(roomId)?.getMember(id)?.name || id) + ' profile'} onClick={() => onProfile(id)}><span>{getMatrixClient()?.getRoom(roomId)?.getMember(id)?.name || id}</span><small>{id}</small></button>)}</div>{users.length > 100 && <small>Showing the first 100 people.</small>}</PopoverContent></Popover>
    </span>;
  })}</div>;
}
