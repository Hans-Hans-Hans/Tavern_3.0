import React from 'react';
import { createRoot } from 'react-dom/client';
import { MessageSearch } from '../../../app/message-search';
import * as search from '../../../lib/search-index';

export async function mountFixture() {
  const f = (window as any).searchFixture;
  const owner = f.owner;
  f.search = search; await search.initializeSearch(f.client, () => f.owner === owner);
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((await search.searchIndexStatus()).indexedCount === 3) break;
    if (attempt === 299) throw new Error('Fixture indexing failed');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  createRoot(document.getElementById('root')!).render(<MessageSearch roomId="!room:local" onSelect={message => f.chosen.push('message:' + message.id)}
    onSelectRoom={id => f.chosen.push('room:' + id)} onSelectServer={id => f.chosen.push('server:' + id)} onSelectPerson={(id, room) => f.chosen.push('person:' + id + ':' + room)}/>);
  f.ready = true;
}
