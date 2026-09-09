import { useEffect, useState } from 'react';
import { onMatrixUpdate } from '@/lib/matrix';
import { afkDestinations, afkTimeouts, canManageServerAfk, emptyServerAfk, readServerAfk, saveServerAfk } from '@/lib/server-afk';

export function ServerAfkSettings({ serverId }: { serverId: string }) {
  const [previous, setPrevious] = useState(() => readServerAfk(serverId)), [value, setValue] = useState(() => previous || emptyServerAfk());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [, redraw] = useState(0);
  useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  useEffect(() => { const current = readServerAfk(serverId); setPrevious(current); setValue(current || emptyServerAfk()); setError(''); setSaved(false); }, [serverId]);
  if (!canManageServerAfk(serverId)) return error ? <p role='alert' className='connect-error'>{error}</p> : null;
  const choices = afkDestinations(serverId);
  return <section className='product-section'><h3>AFK voice channel</h3>
    <p>Choose an encrypted voice channel and an inactivity timeout. Members can opt in separately for each conference to leave after no keyboard, pointer or touch interaction in this Tavern tab. They can then open this destination and choose whether to join.</p>
    <p>This does not move members automatically or monitor speech. Listening, speaking and screen sharing do not count as interaction. Browser suspension may delay the timer.</p>
    {!previous && <p role='alert'>Saved AFK settings are invalid. Review and save a replacement.</p>}
    <form className='dialog-form' onSubmit={async event => { event.preventDefault(); setBusy(true); setSaved(false); setError(''); try { const next = await saveServerAfk(serverId, value, previous); setPrevious(next); setValue(next); setSaved(true); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }}>
      <fieldset disabled={busy}><label>AFK destination<select value={value.channelId} onChange={event => setValue(value => ({ ...value, channelId: event.target.value }))}><option value=''>Disabled</option>{value.channelId && !choices.some(room => room.id === value.channelId) && <option value={value.channelId}>Unavailable channel — choose another</option>}{choices.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>
        <label>AFK timeout<select value={value.timeoutSeconds} onChange={event => setValue(value => ({ ...value, timeoutSeconds: Number(event.target.value) }))}>{afkTimeouts.map(seconds => <option key={seconds} value={seconds}>{seconds / 60} minutes</option>)}</select></label>
        <button className='primary-button'>Save AFK settings</button><button className='secondary-button' type='button' onClick={() => { const current = readServerAfk(serverId); setPrevious(current); setValue(current || emptyServerAfk()); setError(''); setSaved(false); }}>Reload AFK settings</button>
      </fieldset>
    </form>{saved && <p role='status'>AFK settings saved.</p>}{error && <p role='alert' className='connect-error'>{error}</p>}
  </section>;
}
