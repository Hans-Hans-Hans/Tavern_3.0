import { useEffect, useState } from 'react';
import { Bookmark, CalendarDays, MessageCircle, AtSign, CircleHelp } from 'lucide-react';
import { getMatrixClient, matrixApi, onMatrixUpdate } from '@/lib/matrix';
import { accountArtworkOwner } from '@/lib/api';
import { projectWork } from '@/lib/collaboration';
import { navigationScope, readConversationMemory, saveConversationMemory } from '@/lib/conversation-memory';
import { openWelcomeTour } from './welcome-tour';
import { ExperienceError } from './experience-error';
import './experience.css';
type Room = { id: string; name: string; kind: string; unread?: number };
export function PersonalHome({ rooms, onSelect, onMessage, onView, onStart }: { rooms: Room[]; onSelect: (id: string) => void; onMessage: (room: string, event: string) => void; onView: (view: string) => void; onStart: () => void }) {
  const client = getMatrixClient(), owner = accountArtworkOwner(), scope = navigationScope(client);
  const [landing, setLanding] = useState(() => readConversationMemory(scope).landing), [mentions, setMentions] = useState<any[]>([]), [saved, setSaved] = useState(0), [error, setError] = useState<unknown>(null), [refresh, setRefresh] = useState(0), [, tick] = useState(0);
  useEffect(() => { let timer:ReturnType<typeof setTimeout>|undefined;const stop=onMatrixUpdate(()=>{tick(value=>value+1);if(timer===undefined)timer=setTimeout(()=>{timer=undefined;setRefresh(value=>value+1);},1000);});return()=>{stop();if(timer!==undefined)clearTimeout(timer);}; }, []);
  useEffect(()=>{setMentions([]);setSaved(0);setLanding(readConversationMemory(scope).landing);},[client,owner,scope]);
  useEffect(() => {
    let active = true; setError(null);
    void Promise.all([matrixApi('mentions'), matrixApi('saved')]).then(([mentions, saved]) => { if (active && getMatrixClient() === client && accountArtworkOwner() === owner) { setMentions(mentions.messages.slice(0,5)); setSaved(saved.messages.length); } }).catch(error => { if (active && getMatrixClient() === client && accountArtworkOwner() === owner) setError(error); });
    return () => { active = false; };
  }, [client, owner, scope, refresh]);
  const events = rooms.slice(0, 100).flatMap(room => {
    const native = client?.getRoom(room.id);
    return native?.getMyMembership() === 'join' ? projectWork(native.getLiveTimeline().getEvents()).filter(item => item.kind === 'event' && Date.parse(item.due) > Date.now()).map(item => ({ ...item, room })) : [];
  }).sort((a, b) => Date.parse(a.due) - Date.parse(b.due)).slice(0, 6);
  return <section className="personal-home"><header><h2>Welcome home</h2><p>Your conversations, saved items and upcoming plans.</p><label className="check-label"><input type="checkbox" checked={landing === 'home'} onChange={event => { const next = event.target.checked ? 'home' : 'last'; saveConversationMemory(scope, { landing: next }); setLanding(next); }}/>Open Home when I return to Tavern</label><p className="login-help">Otherwise, resume your last conversation. This preference stays on this browser.</p></header>
    <div className="home-actions"><button className="secondary-button" onClick={() => onView('mentions')}><AtSign size={18}/>Mentions</button><button className="secondary-button" onClick={() => onView('saved')}><Bookmark size={18}/>Saved items ({saved})</button><button className="secondary-button" onClick={openWelcomeTour}><CircleHelp size={18}/>Getting started</button></div>
    <ExperienceError error={error} retry={() => setRefresh(value => value + 1)}/>
    <div className="home-grid"><article><h3><MessageCircle size={18}/>Direct messages</h3>{rooms.filter(room => room.kind === 'dm').sort((a, b) => (b.unread || 0) - (a.unread || 0)).slice(0, 8).map(room => <button className="home-list-item" key={room.id} onClick={() => onSelect(room.id)}><span>{room.name}</span>{!!room.unread && <span>{room.unread} unread</span>}</button>)}<button className="secondary-button" onClick={onStart}>Start a conversation</button></article>
      <article><h3><AtSign size={18}/>Recent mentions</h3>{mentions.length ? mentions.map(message => <button className="home-list-item" key={message.id} onClick={() => onMessage(message.conversation_id, message.id)}><span>{message.author_name || 'A member'}<small>{message.body?.slice(0, 160)}</small></span></button>) : <p>No mentions in your loaded messages.</p>}</article>
      <article><h3><CalendarDays size={18}/>Coming up</h3>{events.length ? events.map(item => <button className="home-list-item" key={item.id} onClick={() => onMessage(item.room.id, item.id)}><span>{item.title}<small>{new Date(item.due).toLocaleString()} · {item.room.name}</small></span></button>) : <p>Create an event from a channel’s Work tab to make plans together.</p>}<p className="login-help">Events shown here come from history already loaded on this device.</p></article></div>
  </section>;
}
