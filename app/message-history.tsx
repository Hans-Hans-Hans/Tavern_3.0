import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { accountArtworkOwner } from '@/lib/api';
import { createMatrixMessageHistory, getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import type { MessageHistorySnapshot } from '@/lib/message-history';
import { MessageList } from './message-list';
import './message-history.css';

type Reader = ReturnType<typeof createMatrixMessageHistory>;
type Message = Awaited<ReturnType<Reader['load']>>['messages'][number];
type Snapshot = MessageHistorySnapshot<Message>;
export function MessageHistoryPanel({ roomId, eventId, isCurrent, renderMessage, onClose, onLatest }: {
  roomId: string; eventId: string; isCurrent: () => boolean;
  renderMessage: (message: Message, messages: Message[], current: () => boolean) => ReactNode;
  onClose: () => void; onLatest: () => void;
}) {
  const binding = useMemo(() => {
    const client = getMatrixClient();
    return { client, actor: client?.getUserId(), device: client?.getDeviceId(), base: client?.getHomeserverUrl(),
      account: accountArtworkOwner(), room: client?.getRoom(roomId), roomId, eventId };
  }, [roomId, eventId]);
  const activeBinding = useRef(binding); activeBinding.current = binding;
  const mounted = useRef(false), reader = useRef<Reader | null>(null), request = useRef(0), pending = useRef(false);
  const currentCallback = useRef(isCurrent); currentCallback.current = isCurrent;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [busy, setBusy] = useState('Opening message context…');
  const [error, setError] = useState(''), [invalid, setInvalid] = useState(false), [focus, setFocus] = useState<{ id: string; request: number } | null>(null);
  const scroll = useRef<HTMLDivElement | null>(null);
  const current = () => mounted.current && activeBinding.current === binding && currentCallback.current() && getMatrixClient() === binding.client && accountArtworkOwner() === binding.account &&
    binding.client?.getUserId() === binding.actor && binding.client?.getDeviceId() === binding.device && binding.client?.getHomeserverUrl() === binding.base &&
    binding.client?.getRoom(roomId) === binding.room && binding.room?.getMyMembership() === 'join';
  const latestCheck = useRef(current); latestCheck.current = current;
  const retire = () => { request.current++; reader.current?.dispose(); reader.current = null; pending.current = false; };
  async function run(action: 'load' | 'older' | 'newer' | 'refresh') {
    if (!current() || pending.current) return;
    if (action !== 'load' && !reader.current) return;
    const serial = ++request.current;
    pending.current = true; setError(''); setBusy(action === 'load' ? 'Opening message context…' : action === 'refresh' ? 'Updating displayed messages…' : 'Loading ' + (action === 'older' ? 'earlier' : 'later') + ' messages…');
    try {
      if (action === 'load') { reader.current?.dispose(); reader.current = createMatrixMessageHistory(roomId, eventId, current); setSnapshot(null); }
      const source = reader.current!;
      const value = await (action === 'load' ? source.load() : action === 'refresh' ? source.refresh() : source.page(action));
      if (!current() || request.current !== serial || reader.current !== source) return;
      setSnapshot(value);
      if (action === 'load') setFocus({ id: eventId, request: serial });
    } catch (failure) {
      if (current() && request.current === serial) setError((failure as Error).message);
    } finally {
      if (request.current === serial) { pending.current = false; if (current()) setBusy(''); }
    }
  }
  useEffect(() => {
    mounted.current = true; setInvalid(false); void run('load');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (!latestCheck.current()) { retire(); setSnapshot(null); setInvalid(true); setBusy(''); return false; }
      return true;
    };
    const stop = onMatrixUpdate(() => {
      if (!check() || timer) return;
      timer = setTimeout(() => { timer = undefined; if (check() && !document.hidden && !pending.current) void run('refresh'); }, 250);
    });
    const poll = window.setInterval(check, 250);
    window.addEventListener('tavern:signout', check);
    return () => { mounted.current = false; retire(); stop(); clearInterval(poll); clearTimeout(timer); window.removeEventListener('tavern:signout', check); };
  }, [binding]);
  const visible = current() && !invalid ? snapshot : null;
  return <section className="message-history-panel" aria-label="Message context">
    <div className="message-history-controls"><button type="button" className="secondary-button" disabled={!current()} onClick={() => { if (current()) onLatest(); }}>Back to latest</button><button type="button" className="secondary-button" onClick={onClose}>Close message context</button></div>
    <p className="login-help">Read the surrounding conversation in a bounded window. Older encrypted messages need their original keys; opening history does not replace missing encryption keys.</p>
    {invalid && <p className="connect-error" role="alert">Your account or conversation access changed. Close this context and reopen the message.</p>}
    {error && <p className="connect-error" role="alert">{error}</p>}
    {busy && <p role="status">{busy}</p>}
    <div className="message-history-controls"><button type="button" className="secondary-button" disabled={!!busy || !visible?.older} onClick={() => void run('older')}>Load earlier</button>
      <button type="button" className="secondary-button" disabled={!!busy || !visible?.newer} onClick={() => void run('newer')}>Load later</button>
      <button type="button" className="secondary-button" disabled={!!busy || !current()} onClick={() => void run('load')}>{error ? 'Retry message context' : 'Return to selected message'}</button></div>
    {visible?.limited && <p role="status">This window has reached its 500-event limit. Paging can remove messages at the other end of the window.</p>}
    {visible?.emptyPage && <p role="status">This page added no displayed messages. More history may still be available; use the page controls to continue.</p>}
    {visible && !visible.targetPresent && <p>The selected message is outside the current window.</p>}
    {visible?.atLive && <p className="login-help">This window reaches the currently synced conversation.</p>}
    <div className="message-history-scroll" ref={scroll} tabIndex={0} aria-label="Conversation history">
      {visible && <MessageList items={visible.messages} scroll={scroll} focusId={focus} render={message => <div className={message.id === eventId ? 'message-history-target' : undefined} aria-label={message.id === eventId ? 'Selected message' : undefined}>{renderMessage(message, visible.messages, current)}</div>}/>}
      {visible && !visible.messages.length && <p>No displayable messages in this window. Messages may be redacted, undecryptable, or outside the conversation timeline.</p>}
    </div>
  </section>;
}
