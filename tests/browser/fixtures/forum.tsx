import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ForumChannel } from '../../../app/forum-channel';
import '../../../app/globals.css';
const record = (index: number) => ({ id: '$post' + index, body: 'Discussion body ' + index, forum: { title: 'Discussion ' + index, tags: ['general'] }, parent_id: null, pinned: 0, replies: 0, created_at: 1700000000000 + index, author_id: '@member:local', author_name: 'Member', reactions: [] });
function Fixture() {
  const w = window as any, empty = location.search.includes('empty');
  const [messages, setMessages] = useState(empty ? [] : Array.from({ length: 60 }, (_, index) => record(index))), [hasMore, setHasMore] = useState(true);
  w.submissions ||= []; w.historyCalls ||= 0;
  const room = { roomId: '!forum:local', isSpaceRoom: () => false, hasEncryptionStateEvent: () => true, getMyMembership: () => 'join', getMember: (id: string) => ({ name: id, powerLevel: 0, membership: 'join' }), getThread: () => null,
    currentState: { maySendEvent: () => true, maySendStateEvent: () => false, getStateEvents: (type: string, key: string) => type === 'm.space.parent' ? [] : type === 'io.tavern.thread' ? { getContent: () => key === '$post5' ? { archived: true } : key === '$post6' ? { closed: true } : key === '$post7' ? { locked: true } : {} } : null } };
  w.fixtureClient = { getRoom: () => room, getRooms: () => [room], getUserId: () => '@member:local', getAccountData: () => null };
  w.fixtureApi = async (action: string, data: any) => { w.submissions.push({ action, ...data }); if (w.submissions.length === 1) throw new Error('The send was not confirmed. Retry with this draft.'); return { id: '$sent' }; };
  return <ForumChannel roomId='!forum:local' messages={messages} hasMore={hasMore} loadingHistory={false} onOpen={value => { w.opened = value.id; }} onProfile={() => {}} onSent={async () => {}} onLoadHistory={async () => { w.historyCalls++; setMessages(old => [record(-1), ...old]); setHasMore(false); }}/>;
}
export function mountFixture() { createRoot(document.getElementById('root')!).render(<Fixture/>); }
