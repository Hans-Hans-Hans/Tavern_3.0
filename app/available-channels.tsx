import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner, requestApi } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { readRolePolicy } from '@/lib/roles';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Channel = { id: string; name: string; kind: string; joined: boolean };
export function AvailableChannels({ serverId, onOpen }: { serverId: string; onOpen: (id: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false), [, redraw] = useState(0);
  const client = getMatrixClient(), account = accountArtworkOwner(), scope = useRef({ client, account, serverId, generation: 0 });
  if (scope.current.client !== client || scope.current.account !== account || scope.current.serverId !== serverId) scope.current = { client, account, serverId, generation: scope.current.generation + 1 };
  useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  if (readRolePolicy(serverId)?.channelAdmissionVersion !== 1) return null;
  return <><button type='button' className='channel-link' onClick={() => setOpen(true)}>Browse private channels</button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Available private channels</DialogTitle><DialogDescription>Channels whose selected roles or member list currently include you. Choose one to join using your account.</DialogDescription></DialogHeader>
      {open && <ChannelList key={scope.current.generation} serverId={serverId} onOpen={async id => { await onOpen(id); setOpen(false); }}/>}
    </DialogContent></Dialog></>;
}

function ChannelList({ serverId, onOpen }: { serverId: string; onOpen: (id: string) => Promise<unknown> }) {
  const [owner] = useState(() => ({ client: getMatrixClient(), account: accountArtworkOwner() })), alive = useRef(true);
  const current = () => alive.current && owner.client === getMatrixClient() && owner.account === accountArtworkOwner();
  const [rows, setRows] = useState<Channel[]>([]), [next, setNext] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function load(after = '') {
    setBusy(true); setError('');
    try {
      const data = await requestApi('/api/servers/' + encodeURIComponent(serverId) + '/channels/available' + (after ? '?after=' + encodeURIComponent(after) : ''));
      if (!current()) return;
      if (!Array.isArray(data.channels) || data.channels.length > 25 || data.channels.some((row: Channel) => !row || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.kind !== 'string' || typeof row.joined !== 'boolean') || data.next !== null && typeof data.next !== 'string') throw new Error('The channel list could not be read.');
      setRows(previous => after ? [...previous, ...data.channels.filter((row: Channel) => !previous.some(item => item.id === row.id))] : data.channels); setNext(data.next);
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  async function join(row: Channel) {
    if (!current() || busy || !owner.client) return;
    setBusy(true); setError('');
    try {
      if (owner.client.getRoom(row.id)?.getMyMembership() !== 'join') await owner.client.joinRoom(row.id);
      if (!current()) return;
      const client = owner.client;
      if (client.getRoom(row.id)?.getMyMembership() !== 'join') await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const stop = onMatrixUpdate(check);
        function check() {
          if (!current()) { stop(); clearTimeout(timer); reject(new Error('Your account changed.')); }
          else if (client.getRoom(row.id)?.getMyMembership() === 'join') { stop(); clearTimeout(timer); resolve(); }
        }
        timer = setTimeout(() => { stop(); reject(new Error('The join was accepted, but channel sync is still pending. Refresh Tavern.')); }, 15000); check();
      });
      if (current()) await onOpen(row.id);
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  return <section className='dialog-form' aria-label='Eligible private channels'>
    {rows.map(row => <div className='room-invite' key={row.id}><span><strong>{row.name}</strong><small>{row.kind}</small></span><button className='primary-button' disabled={busy} onClick={() => void join(row)}>{row.joined ? 'Open channel' : 'Join channel'}</button></div>)}
    {!busy && !rows.length && <p>No eligible channels on this page.</p>}
    {error && <p role='alert' className='connect-error'>{error}</p>}
    <div className='inline-actions'><button className='secondary-button' disabled={busy} onClick={() => void load()}>Refresh channels</button>{next && <button className='secondary-button' disabled={busy} onClick={() => void load(next)}>More channels</button>}</div>
  </section>;
}
