import { useEffect, useRef, useState } from 'react';
import { searchMessages, indexRoomHistory, clearSearchIndex, type SearchDocument } from '@/lib/search-index';
import { getMatrixClient, onMatrixUpdate, resolveMatrixMessage } from '@/lib/matrix';
import { accountArtworkOwner } from '@/lib/api';
import { captureSearchInventory, type SearchCategory, type SearchInventory, type SearchInventoryResult } from '@/lib/unified-search';
import { RichMessage } from './rich-message';
import { MediaViewer, type MediaAttachment } from './media-viewer';

type SearchView = { key: string; inventory: SearchInventory; places: SearchInventoryResult[]; nextOffset: number | null; hits: SearchDocument[]; cursor: string | null; count: number; truncated: boolean };
type Props = { initialQuery?: string; roomId: string; onSelect: (message: any) => void; onSelectRoom?: (roomId: string) => void; onSelectServer?: (roomId: string) => void; onSelectPerson?: (userId: string, roomId: string) => void };

export function MessageSearch({ initialQuery = '', roomId, onSelect, onSelectRoom, onSelectServer, onSelectPerson }: Props) {
  const [query, setQuery] = useState(initialQuery), [scope, setScope] = useState('all'), [category, setCategory] = useState<SearchCategory>('all');
  const [view, setView] = useState<SearchView | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState('');
  const [refresh, setRefresh] = useState(0), [indexingNow, setIndexingNow] = useState(false), [continuation, setContinuation] = useState<{ roomId: string; cursor: string; inventory: SearchInventory } | null>(null);
  const [, redraw] = useState(0);
  const [media, setMedia] = useState<{ items: MediaAttachment[]; index: number; roomId: string; inventory: SearchInventory; isCurrent: () => boolean } | null>(null);
  const generation = useRef(0), indexing = useRef<AbortController | null>(null), searching = useRef<AbortController | null>(null), alive = useRef(true);
  const client = getMatrixClient(), owner = accountArtworkOwner(), key = JSON.stringify([query, scope, category, roomId]);
  const mounted = useRef({ client, owner, actor: client?.getUserId(), device: client?.getDeviceId() });
  const sameSession = () => mounted.current.client === getMatrixClient() && mounted.current.owner === accountArtworkOwner() && mounted.current.actor === getMatrixClient()?.getUserId() && mounted.current.device === getMatrixClient()?.getDeviceId();
  const currentKey = useRef(key); currentKey.current = key;
  const owned = (inventory: SearchInventory) => { try { inventory.assertCurrent(); return true; } catch { return false; } };
  const currentView = view?.key === key && owned(view.inventory) ? view : null;
  const visibleMedia = media?.isCurrent() ? media : null;
  const canIndex = sameSession() && !!client?.getRoom(roomId) && client.getRoom(roomId)?.getMyMembership() === 'join' && !client.getRoom(roomId)?.isSpaceRoom();

  useEffect(() => {
    alive.current = true;
    let previousClient = getMatrixClient(), previousOwner = accountArtworkOwner(), previousActor = previousClient?.getUserId(), previousDevice = previousClient?.getDeviceId();
    const check = () => {
      const next = getMatrixClient(), nextOwner = accountArtworkOwner();
      if (next !== previousClient || nextOwner !== previousOwner || next?.getUserId() !== previousActor || next?.getDeviceId() !== previousDevice) {
        previousClient = next; previousOwner = nextOwner; previousActor = next?.getUserId(); previousDevice = next?.getDeviceId();
        generation.current++; searching.current?.abort(); indexing.current?.abort(); setView(null); setMedia(null); setContinuation(null); setProgress(''); setRefresh(value => value + 1);
      }
    };
    // Sync can deliver typing/reactions continuously. Recheck visible access
    // without cancelling this query or resetting pages the user already read.
    const stop = onMatrixUpdate(() => { check(); redraw(value => value + 1); }), timer = setInterval(check, 250);
    return () => { alive.current = false; generation.current++; searching.current?.abort(); indexing.current?.abort(); stop(); clearInterval(timer); };
  }, []);

  async function search(more = false) {
    const run = ++generation.current, source = client, sourceOwner = owner, sourceActor = source?.getUserId(), sourceDevice = source?.getDeviceId();
    searching.current?.abort(); const controller = new AbortController(); searching.current = controller; setBusy(true); setError('');
    try {
      if (!source) throw new Error('Sign in and wait for your Matrix session before searching.');
      if (!sameSession()) throw new Error('Your account changed. Close and reopen search for the current session.');
      const inventory = more && currentView ? currentView.inventory : captureSearchInventory(source,
        () => alive.current && sameSession() && getMatrixClient() === source && accountArtworkOwner() === sourceOwner && source.getUserId() === sourceActor && source.getDeviceId() === sourceDevice,
        scope === 'room' ? [roomId] : undefined);
      inventory.assertCurrent();
      const metadata = inventory.search(query, category);
      const base: SearchView = more && currentView ? currentView : { key, inventory, places: metadata.items, nextOffset: metadata.nextOffset, hits: [], cursor: null, count: 0, truncated: metadata.truncated };
      if (run !== generation.current) return;
      setView(base);
      if (['all', 'messages', 'files'].includes(category)) {
        const result = await searchMessages(query, { limit: 30, signal: controller.signal, roomIds: [...inventory.rooms.keys()],
          ...(more && base.cursor ? { cursor: base.cursor } : {}), ...(category === 'messages' || category === 'files' ? { kind: category } : {}) });
        inventory.assertCurrent(); if (run !== generation.current) return;
        setView({ ...base, hits: more ? [...new Map([...base.hits, ...result.hits].map(hit => [hit.id, hit])).values()] : result.hits, cursor: result.nextCursor, count: result.indexedCount });
      }
    } catch (failure: any) { if (run === generation.current && !controller.signal.aborted) setError(failure.message || 'Search is unavailable.'); }
    finally { if (run === generation.current) setBusy(false); }
  }
  useEffect(() => { generation.current++; searching.current?.abort(); const timer = setTimeout(() => void search(), 250); return () => { clearTimeout(timer); generation.current++; searching.current?.abort(); }; }, [key, refresh, client, owner]);
  useEffect(() => { indexing.current?.abort(); setContinuation(null); setProgress(''); setMedia(null); }, [roomId, client, owner]);

  function morePlaces() {
    if (!currentView || currentView.nextOffset === null) return;
    try { const result = currentView.inventory.search(query, category, currentView.nextOffset); setView({ ...currentView, places: [...currentView.places, ...result.items], nextOffset: result.nextOffset }); }
    catch (failure: any) { setError(failure.message); }
  }
  function openPlace(item: SearchInventoryResult) {
    if (!currentView) return;
    try { currentView.inventory.assertResult(item); if (item.kind === 'person') onSelectPerson?.(item.userId, item.roomId); else if (item.kind === 'server') onSelectServer?.(item.roomId); else onSelectRoom?.(item.roomId); }
    catch (failure: any) { setError(failure.message); }
  }
  async function openMessage(document: SearchDocument, preview = false) {
    if (!currentView) return;
    const inventory = currentView.inventory, selectedKey = key;
    try {
      inventory.assertRoom(document.roomId); const message = await resolveMatrixMessage(document.roomId, document.id); inventory.assertRoom(document.roomId);
      if (selectedKey !== currentKey.current) return;
      if (message.id !== document.id || message.conversation_id !== document.roomId) throw new Error('The message no longer matches this search result.');
      if (preview) {
        if (!message.attachments?.length) throw new Error('This message no longer has an available attachment.');
        const isCurrent = () => { try { inventory.assertRoom(document.roomId); return true; } catch { return false; } };
        setMedia({ items: message.attachments, index: 0, roomId: document.roomId, inventory, isCurrent });
      } else onSelect(message);
    } catch (failure: any) { if (selectedKey === currentKey.current && owned(inventory)) setError(failure.message); }
  }
  async function indexHistory() {
    if (!client || !canIndex || indexing.current || !sameSession()) return;
    const source = client, sourceOwner = owner, actor = source.getUserId(), device = source.getDeviceId();
    const inventory = captureSearchInventory(source, () => alive.current && getMatrixClient() === source && accountArtworkOwner() === sourceOwner && source.getUserId() === actor && source.getDeviceId() === device, [roomId]);
    const controller = new AbortController(); indexing.current = controller; setIndexingNow(true); setError(''); setProgress('Indexing this conversation…');
    try {
      const cursor = continuation?.roomId === roomId && owned(continuation.inventory) ? continuation.cursor : undefined;
      const result = await indexRoomHistory(roomId, value => { inventory.assertRoom(roomId); if (!controller.signal.aborted) setProgress(value.indexed.toLocaleString() + ' events processed in this run.'); }, controller.signal, { cursor, maxPages: 20 });
      inventory.assertRoom(roomId); if (controller.signal.aborted) return;
      setContinuation(result.nextCursor ? { roomId, cursor: result.nextCursor, inventory } : null);
      setProgress(result.complete ? 'Reached the start of history available to this account.' : 'Processed 20 pages. Continue when you want to index more of this conversation.');
      setRefresh(value => value + 1);
    } catch (failure: any) { if (owned(inventory)) { if (controller.signal.aborted) setProgress('Indexing stopped. Completed records remain searchable.'); else setError(failure.message); } }
    finally { if (indexing.current === controller) indexing.current = null; if (alive.current) setIndexingNow(false); }
  }
  async function clearIndex() {
    if (!currentView) return;
    const inventory = currentView.inventory;
    try { inventory.assertCurrent(); indexing.current?.abort(); await clearSearchIndex(); inventory.assertCurrent(); setContinuation(null); setProgress('Local index cleared. New messages will be indexed as they arrive.'); setRefresh(value => value + 1); }
    catch (failure: any) { if (owned(inventory)) setError(failure.message); }
  }
  const categories: [SearchCategory, string][] = [['all', 'Everything'], ['messages', 'Messages'], ['files', 'Files'], ['people', 'People'], ['channels', 'Channels and conversations'], ['servers', 'Servers']];
  return <>
    <div className="input-with-icon search-input"><input autoFocus aria-label="Search Tavern" placeholder='Search messages, files, people, channels, or servers' value={query} maxLength={1000} onChange={event => setQuery(event.target.value)}/></div>
    <div className="product-actions"><label>Find <select aria-label="Result type" value={category} onChange={event => setCategory(event.target.value as SearchCategory)}>{categories.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label><label>Within <select aria-label="Search scope" value={scope} onChange={event => setScope(event.target.value)}><option value="all">Joined rooms on this device</option><option value="room">Current conversation</option></select></label><button type="button" className="secondary-button" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>Refresh results</button></div>
    <small>Message and file filters: from:username in:channel before:2026-09-01 after:2026-08-01 has:image has:file has:link mentions:me</small>
    <p role="status">{busy ? 'Searching…' : ['all', 'messages', 'files'].includes(category) ? (currentView?.count.toLocaleString() || '0') + ' messages indexed on this device.' : 'Showing currently loaded shared-room members and joined rooms.'}</p>
    {currentView?.truncated && <p>The loaded room or member inventory reached its limit. Narrow the scope to search a specific conversation.</p>}
    {error && <p className="connect-error" role="alert">{error}</p>}
    <div className="search-results">
      {!!currentView?.places.length && <section aria-label="People and places"><h3>People and places</h3>{currentView.places.filter(item => currentView.inventory.accessible(item)).map(item => <article className="message-search-result" key={item.kind + item.id}><button type="button" className="search-result-open" disabled={item.kind === 'person' ? !onSelectPerson : item.kind === 'server' ? !onSelectServer : !onSelectRoom} onClick={() => openPlace(item)}><span><strong>{item.name}</strong><small>{item.detail}</small></span><span>{item.kind === 'person' ? 'Open profile' : item.kind === 'server' ? 'Open server' : 'Open conversation'}</span></button></article>)}{currentView.nextOffset !== null && <button type="button" className="secondary-button" onClick={morePlaces}>More people and places</button>}</section>}
      {['all', 'messages', 'files'].includes(category) && <section aria-label="Indexed messages and files"><h3>{category === 'files' ? 'Files' : category === 'messages' ? 'Messages' : 'Messages and files'}</h3>{currentView?.hits.filter(document=>{try{currentView.inventory.assertRoom(document.roomId);return !client?.getIgnoredUsers().includes(document.authorId)&&!client?.getRoom(document.roomId)?.findEventById(document.id)?.isRedacted();}catch{return false;}}).map(document => <article className="message-search-result" key={document.id}>
        <button type="button" className="search-result-open" aria-label={'Open message in ' + document.roomName + ' by ' + document.authorName} onClick={() => void openMessage(document)}><span><strong>{document.roomName}</strong><small>{new Date(document.timestamp).toLocaleString()}</small></span><span>Open message</span></button>
        {document.has.includes('file') && <button type="button" className="file-card" aria-label={'Open file ' + (document.file?.name || document.body || 'Attachment')} onClick={() => void openMessage(document, true)}><span><strong>{document.file?.name || document.body || 'Attachment'}</strong><small>{document.file?.mime || document.file?.kind || 'Indexed attachment'}{document.file?.size != null ? ' · ' + document.file.size.toLocaleString() + ' bytes' : ''}</small></span><span>Preview or download</span></button>}
        {document.body !== document.file?.name && <RichMessage text={document.body}/>}<small>{document.authorName}</small>
      </article>)}{currentView?.cursor && <button type="button" className="secondary-button" disabled={busy} onClick={() => void search(true)}>More messages and files</button>}</section>}
      {!busy && currentView && !currentView.hits.length && !currentView.places.length && !error && <p>No matches in the indexed history or currently loaded inventory.</p>}
    </div>
    <details><summary>History coverage and search privacy</summary><p>Message bodies, filenames and media metadata are encrypted in this device's index. People and places come from joined rooms and already loaded members; this is not a complete user directory. Message filters apply to indexed messages and files.</p><p>Older history is fetched only when you choose it, one conversation at a time and at most 20 pages per run. Missing keys or unavailable history cannot be searched. Existing older index records gain file metadata when their messages are indexed again.</p><div className="product-actions"><button type="button" className="secondary-button" disabled={!canIndex || indexingNow} onClick={() => void indexHistory()}>{continuation?.roomId === roomId ? 'Continue indexing this conversation' : 'Index older history in this conversation'}</button>{indexingNow && <button type="button" className="secondary-button" onClick={() => indexing.current?.abort()}>Cancel indexing</button>}<button type="button" className="secondary-button" disabled={!currentView} onClick={() => void clearIndex()}>Clear local search index</button></div>{progress && <p role="status">{progress}</p>}</details>
    {visibleMedia && <MediaViewer items={visibleMedia.items} index={visibleMedia.index} isCurrent={visibleMedia.isCurrent} onChange={index => setMedia({ ...visibleMedia, index })} onClose={() => setMedia(null)}/>}
  </>;
}
