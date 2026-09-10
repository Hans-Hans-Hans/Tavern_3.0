import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner } from '@/lib/api';
import { fetchHierarchy, HIERARCHY_DEPTH, HIERARCHY_NODES, type HierarchyPage, type HierarchyRoom } from '@/lib/admin-hierarchy';
import './admin-room-hierarchy.css';

type Step = { id: string; direction?: 'parent' | 'child' };
type Node = { id: string; path: Step[]; page?: HierarchyPage; loading?: boolean; error?: string; revision: number; displayLimited?: boolean };
function Metadata({ room }: { room: HierarchyRoom }) {
  if (room.status === 'unavailable') return <p role="status">{room.reason}</p>;
  return <dl className="admin-hierarchy-metadata"><dt>Native creator{room.creators!.length === 1 ? '' : 's'}</dt><dd>{room.creators!.join(', ')}{room.creatorAuthority === 'inherent' && ' (inherent room authority in version 12)'}</dd>
    <dt>Created</dt><dd>{room.createdAt ? new Date(room.createdAt).toLocaleString() : 'Unavailable in native create event'}</dd>
    <dt>Current joined members</dt><dd>{room.joinedMembers}</dd><dt>Native room version</dt><dd>{room.roomVersion}</dd>
    <dt>Encryption</dt><dd>{room.encryption || 'No encryption state'}</dd><dt>Join rule</dt><dd>{room.joinRule || 'Unavailable'}</dd>
    <dt>Archive state</dt><dd>{room.archived === null ? 'Unavailable' : room.archived ? 'Archived' : 'Not archived'}</dd>
    {room.replacementRoomId && <><dt>Replaced by</dt><dd>{room.replacementRoomId}</dd></>}
    <dt>Room storage and message activity</dt><dd>Unavailable: this inspector reads room metadata only.</dd></dl>;
}

export function AdminRoomHierarchy({ roomId, onInspect }: { roomId: string; onInspect: (roomId: string) => void }) {
  const owner = useRef(accountArtworkOwner()), alive = useRef(true), serial = useRef(0), tracked = useRef<Record<string, Node>>({});
  const [nodes, setNodes] = useState<Record<string, Node>>({}), [stale, setStale] = useState(false);
  const source = useRef(roomId); source.current = roomId;
  const current = () => alive.current && owner.current === accountArtworkOwner() && source.current === roomId;
  const keyFor = (path: Step[]) => JSON.stringify(path);
  function publish(value: Record<string, Node>) { tracked.current = value; setNodes(value); }
  async function load(path: Step[], old?: Node, more = false) {
    if (!current()) return;
    const key = keyFor(path), id = path[path.length - 1].id, revision = ++serial.current;
    const node: Node = { id, path, page: old?.page, loading: true, revision };
    const retained = Object.fromEntries(Object.entries(tracked.current).filter(([, child]) => more || child.path.length <= path.length || !path.every((item, index) => child.path[index].id === item.id && child.path[index].direction === item.direction)));
    publish({ ...retained, [key]: node });
    try {
      const page = await fetchHierarchy(id, more ? old!.page!.nextOffset! : 0, more ? old!.page!.revision! : undefined);
      if (!current() || tracked.current[key]?.revision !== revision) return;
      const existing = more ? old!.page!.links : [];
      const otherLinks = Object.entries(tracked.current).reduce((count, [id, item]) => count + (id === key ? 0 : item.page?.links.length || 0), 0);
      const remaining = Math.max(0, HIERARCHY_NODES - 1 - otherLinks - existing.length);
      const links = [...existing, ...page.links.slice(0, remaining)];
      publish({ ...tracked.current, [key]: { ...node, loading: false, displayLimited: page.links.length > remaining, page: { ...page, links } } });
    } catch (error) {
      if (current() && tracked.current[key]?.revision === revision) publish({ ...tracked.current, [key]: { ...node, loading: false, error: (error as Error).message } });
    }
  }
  useEffect(() => {
    alive.current = true; publish({}); void load([{ id: roomId }]);
    const check = () => { if (!current()) { setStale(true); publish({}); } };
    const timer = window.setInterval(check, 250); window.addEventListener('tavern:signout', check);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener('tavern:signout', check); };
  }, [roomId]);
  if (stale || !current()) return <p role="alert">Your account changed. Reopen room administration.</p>;

  function render(path: Step[]) {
    const key = keyFor(path), node = nodes[key];
    if (!node) return null;
    const page = node.page;
    return <div className="admin-hierarchy-node" key={key}>
      {node.loading && <p role="status">Checking native relationships…</p>}
      {node.error && <p role="alert">{node.error}</p>}
      {page && <><h4>{page.room.name || node.id}</h4><code>{node.id}</code><Metadata room={page.room}/>
        {path.length > 1 && <button type="button" className="secondary-button" onClick={() => { if (current()) onInspect(node.id); }}>Separately inspect {page.room.name || node.id}</button>}
        <p className="login-help">Checked {new Date(page.checkedAt).toLocaleTimeString()}. Relationships can change after this read.</p>
        <ul className="admin-hierarchy-links">{page.links.map(link => {
          const next = [...path, { id: link.roomId, direction: link.direction }], nested = nodes[keyFor(next)], cycle = path.some(step => step.id === link.roomId), depth = path.length >= HIERARCHY_DEPTH;
          return <li key={link.direction + link.roomId}><span>{link.direction === 'parent' ? 'Parent server' : !link.room ? 'Child room' : link.room.kind === 'server' ? 'Child server' : 'Child conversation'}: <strong>{link.room?.name || link.roomId}</strong></span>
            {link.status !== 'confirmed' ? <p>{link.reason}</p> : <><code>{link.roomId}</code>
              {cycle ? <p>Already on this path. Cycle or reciprocal reference; expansion stopped.</p> : nested ? render(next) : <div className="product-actions">
                <button type="button" className="secondary-button" disabled={depth || Object.keys(nodes).length >= HIERARCHY_NODES} onClick={() => { if (!current() || Object.keys(tracked.current).length >= HIERARCHY_NODES || depth || tracked.current[keyFor(next)]) return; void load(next); }}>Expand {link.room?.name || link.roomId}</button>
                <button type="button" className="secondary-button" onClick={() => { if (current()) onInspect(link.roomId); }}>Inspect {link.room?.name || link.roomId}</button>
                {(depth || Object.keys(nodes).length >= HIERARCHY_NODES) && <p>Display limit reached. Inspect this room separately to continue.</p>}</div>}</>}
          </li>;
        })}</ul>
        {!page.links.length && page.room.status === 'available' && <p>No nonempty native relationship candidates.</p>}
        {!!page.omittedLinks && <p>{page.omittedLinks} malformed room identifiers were omitted.</p>}
        {page.truncated && <p>Only the first 200 relationship candidates can be inspected for this room. This is a partial view.</p>}
        {node.displayLimited && <p>The 100-room display limit was reached. This node is partial. Inspect it separately to continue.</p>}
        {page.nextOffset !== null && <button type="button" className="secondary-button" disabled={node.loading || node.displayLimited} onClick={() => void load(path, node, true)}>Load more relationships for {page.room.name || node.id}</button>}
      </>}
      <button type="button" className="secondary-button" disabled={node.loading} onClick={() => void load(path)}>Reload {page?.room.name || node.id}</button>
    </div>;
  }
  return <section aria-label="Server and channel hierarchy"><h3>Server and channel hierarchy</h3>
    <p>Expand current reciprocal Space relationships. Each node loads at most 20 candidates per page; this view stops at 8 levels and 100 room entries. It does not join rooms or inspect message history.</p>
    {render([{ id: roomId }])}
  </section>;
}
