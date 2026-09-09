import { DraftIndicator } from './message-drafts';
import { useRef, useState } from 'react';
import { matrixApi, getMatrixClient } from '@/lib/matrix';
import { postingRestriction } from '@/lib/channel-policy';
import { messagePermissions } from '@/lib/interactions';
import { readThreadPolicy, threadReplyRestriction } from '@/lib/thread-policy';
import { Field } from './auth-gateway';
import { ReactionBar } from './reaction-bar';
import { EmojiPicker } from './emoji-picker';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const pageSize = 25;
export function ForumChannel({ roomId, messages, onOpen, onSent, onProfile, hasMore, loadingHistory, onLoadHistory, serverId }: {
  roomId: string; serverId?: string; messages: any[]; onOpen: (message: any) => void; onSent: () => Promise<unknown>; onProfile: (id: string) => void;
  hasMore: boolean; loadingHistory: boolean; onLoadHistory: () => Promise<unknown>;
}) {
  const [query, setQuery] = useState(''), [sort, setSort] = useState('activity'), [tag, setTag] = useState(''), [status, setStatus] = useState('all'), [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false), [title, setTitle] = useState(''), [body, setBody] = useState(''), [tags, setTags] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const nonce = useRef(''), viewport = useRef<HTMLElement>(null);
  const posts = messages.filter(message => !message.parent_id).map(message => {
    const policy = readThreadPolicy(roomId, message.id), restriction = threadReplyRestriction(roomId, message.id, message.lastActivity);
    return { ...message, forum: { title: policy.title || message.forum?.title, tags: policy.updatedAt ? policy.tags : message.forum?.tags }, policy, restriction,
      archived: policy.archived || !!policy.autoArchiveSeconds && restriction.includes('after inactivity') };
  });
  const allTags = [...new Set(posts.flatMap(message => message.forum?.tags || []))].sort() as string[];
  const filtered = posts.filter(message => (status === 'all' || (status === 'open' ? !message.restriction : status === 'locked' ? message.policy.locked : status === 'archived' ? message.archived : message.policy.closed)) && (!tag || message.forum?.tags?.includes(tag)) && (!query || (message.body + ' ' + (message.forum?.title || '')).toLocaleLowerCase().includes(query.toLocaleLowerCase())))
    .sort((a, b) => b.pinned - a.pinned || (sort === 'replies' ? b.replies - a.replies : sort === 'oldest' ? a.created_at - b.created_at : (b.lastActivity || b.created_at) - (a.lastActivity || a.created_at)));
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1), currentPage = Math.min(page, lastPage), shown = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const restriction = postingRestriction(roomId), canPost = messagePermissions(roomId, getMatrixClient()?.getUserId() || '').send && !restriction;
  function choosePage(value: number) { setPage(value); viewport.current?.scrollTo({ top: 0 }); }
  async function react(id: string, emoji: string) { try { await matrixApi('react', { id, emoji }); await onSent(); } catch (error) { toast.error((error as Error).message); } }
  return <section className='forum-channel' ref={viewport} aria-label='Forum discussions'>
    <div className='product-actions'>
      <input type='search' aria-label='Search forum posts' placeholder='Find a discussion' value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}/>
      <select aria-label='Filter forum tag' value={tag} onChange={event => { setTag(event.target.value); setPage(0); }}><option value=''>All tags</option>{allTags.map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label='Discussion status' value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value='all'>All discussions</option><option value='open'>Open</option><option value='closed'>Closed</option><option value='archived'>Archived</option><option value='locked'>Locked</option></select>
      <select aria-label='Sort forum posts' value={sort} onChange={event => { setSort(event.target.value); setPage(0); }}><option value='activity'>Latest activity</option><option value='replies'>Most replies</option><option value='oldest'>Oldest first</option></select>
      {canPost && <button className='primary-button' onClick={() => setCreating(true)}>New discussion</button>}
    </div>
    <p className='login-help'>{posts.length} discussions loaded on this device. Search, tags, counts and sorting cover loaded history. Load earlier history to discover older discussions.</p>
    {restriction && <p>{restriction}</p>}
    {shown.map(message => <article className='forum-post' key={message.id}>
      <h3><button className='forum-open' onClick={() => onOpen(message)}>{message.pinned ? '📌 ' : ''}{message.forum?.title || message.body.split('\n')[0].slice(0, 120)}</button></h3>
      <p>{message.body.slice(0, 220)}</p><div>{message.forum?.tags?.map((value: string) => <span className='forum-tag' key={value}>{value}</span>)}</div>
      {message.restriction && <p className='composer-restriction'>{message.restriction}</p>}
      <small>{message.author_name} · {message.replies} replies · {new Date(message.created_at).toLocaleDateString()} <DraftIndicator roomId={roomId} parent={message.id} label={'Draft reply to '+(message.forum?.title || 'forum post')}/></small>
      <div className='product-actions'><ReactionBar roomId={roomId} eventId={message.id} reactions={message.reactions || []} canReact={messagePermissions(roomId, message.author_id).react} onProfile={onProfile}/>{messagePermissions(roomId, message.author_id).react && <DropdownMenu><DropdownMenuTrigger asChild><button className='secondary-button' aria-label={'React to ' + (message.forum?.title || 'discussion')}>React</button></DropdownMenuTrigger><DropdownMenuContent><EmojiPicker serverId={serverId} onSelect={emoji => void react(message.id, emoji)} onSelectCustom={emoji => void react(message.id, emoji.uri)}/></DropdownMenuContent></DropdownMenu>}</div>
    </article>)}
    {!shown.length && <p>No discussions match this view.{hasMore ? ' Earlier history may contain more matches.' : canPost ? ' Start a discussion to get things going.' : ''}</p>}
    <div className='product-actions'><button className='secondary-button' disabled={currentPage === 0} onClick={() => choosePage(currentPage - 1)}>Previous discussions</button><span>Page {currentPage + 1} of {lastPage + 1}</span><button className='secondary-button' disabled={currentPage >= lastPage} onClick={() => choosePage(currentPage + 1)}>Next discussions</button>{hasMore && <button className='secondary-button' disabled={loadingHistory} onClick={() => void onLoadHistory().catch(error => toast.error(error.message))}>{loadingHistory ? 'Loading earlier history…' : 'Load earlier forum history'}</button>}</div>
    <Dialog open={creating} onOpenChange={open => { if (!busy) setCreating(open); }}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Start a discussion</DialogTitle><DialogDescription>Replies stay together in a thread.</DialogDescription></DialogHeader>
      <form className='dialog-form' onSubmit={async event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); try {
        nonce.current ||= crypto.randomUUID(); await matrixApi('send', { conversation: roomId, body, forum: { title: title.trim(), tags: [...new Set(tags.split(',').map(value => value.trim()).filter(Boolean))].slice(0, 10) }, nonce: nonce.current });
        nonce.current = ''; setCreating(false); setTitle(''); setBody(''); setTags(''); toast.success('Discussion posted'); await onSent().catch(() => toast.error('Your discussion was sent. Refresh this channel to load its latest history.'));
      } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }}>
        <Field label='Title'><input required disabled={busy} maxLength={120} value={title} onChange={event => { setTitle(event.target.value); nonce.current = ''; }}/></Field>
        <Field label='Post'><textarea required disabled={busy} maxLength={8000} value={body} onChange={event => { setBody(event.target.value); nonce.current = ''; }}/></Field>
        <Field label='Tags (comma separated)'><input disabled={busy} maxLength={300} value={tags} onChange={event => { setTags(event.target.value); nonce.current = ''; }}/></Field>
        {error && <p className='connect-error' role='alert'>{error}</p>}<button className='primary-button' disabled={busy}>Post discussion</button>
      </form>
    </DialogContent></Dialog>
  </section>;
}
