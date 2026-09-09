import { useEffect, useState } from 'react';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { isPrivateDiscussion } from '@/lib/conversation-routing';
import { readPrivateThreadSettings } from '@/lib/private-threads';

export function PrivateDiscussionList({ onOpen }: { onOpen: (roomId: string) => void }) {
  const [, refresh] = useState(0), [query, setQuery] = useState(''), [page, setPage] = useState(0);
  useEffect(() => onMatrixUpdate(() => refresh(value => value + 1)), []);
  const rooms = (getMatrixClient()?.getRooms() || []).filter(room => isPrivateDiscussion(room) && ['join', 'invite'].includes(room.getMyMembership())).map(room => ({ id: room.roomId, invited: room.getMyMembership() === 'invite', ...readPrivateThreadSettings(room) })).filter(room => room.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => a.title.localeCompare(b.title));
  const current = Math.min(page, Math.max(0, Math.ceil(rooms.length / 20) - 1));
  return <section><p>Your joined discussions and invitations. These remain available here if you leave their source channel.</p><label>Find a private discussion<input type='search' value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}/></label><div className='dialog-member-list'>{rooms.slice(current * 20, current * 20 + 20).map(room => <button key={room.id} onClick={() => onOpen(room.id)}><span><strong>{room.title}</strong><small>{room.invited ? 'Invitation' : room.archived ? 'Archived' : 'Joined'} · Encrypted</small></span></button>)}</div>{!rooms.length && <p>No matching private discussions or invitations.</p>}{rooms.length > 20 && <div className='product-actions'><button disabled={current === 0} onClick={() => setPage(current - 1)}>Previous private discussions</button><button disabled={(current + 1) * 20 >= rooms.length} onClick={() => setPage(current + 1)}>Next private discussions</button></div>}</section>;
}
