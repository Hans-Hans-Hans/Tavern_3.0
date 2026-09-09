import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageList } from '../../../app/message-list';
type Item = { id: string; n: number };
const make = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: 'message-' + (start + i), n: start + i }));
function Fixture() {
  const [focus,setFocus]=useState<{id:string;request:number}|null>(null);
  const [items, setItems] = useState(() => make(500, 2000)), [grown, setGrown] = useState(''), scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { (window as any).fixtureReady = true; }, []);
  return <><button onClick={()=>setFocus({id:"message-1234",request:Date.now()})}>Jump to unread</button><button onClick={() => setItems(old => [...make(old[0].n - 100, 100), ...old])}>Prepend history</button><button onClick={() => setItems(old => [...old, ...make(old[old.length - 1].n + 1, 1)])}>Append message</button><button onClick={() => setGrown(document.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId || '')}>Expand previous attachment</button><div ref={scroll} id="message-scroller" style={{ height: 480, overflowY: 'auto', width: 680, position: 'relative' }}><div style={{ height: 150 }}>Channel intro</div><MessageList focusId={focus} items={items} scroll={scroll} render={item => <article data-message-id={item.id} style={{ height: 40 + (item.n % 5) * 27 + (grown === item.id ? 300 : 0), boxSizing: 'border-box', padding: 8, borderBottom: '1px solid gray' }}>{item.id}</article>} /></div></>;
}
export function mountFixture() { createRoot(document.getElementById('root')!).render(<Fixture />); }
