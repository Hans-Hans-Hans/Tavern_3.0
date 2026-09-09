import { useEffect, useState } from 'react';
import { onMatrixUpdate } from '@/lib/matrix';
import { canEditNotificationDefault, readRoomNotificationDefault, saveRoomNotificationDefault } from '@/lib/server-defaults';
import { readNotificationPreferences, type NotificationDefault } from '@/lib/notification-preferences';
import { synchronizeNotificationRules } from '@/lib/notifications';

export function ConversationNotificationDefaults({ roomId, server = false }: { roomId: string; server?: boolean }) {
  const [value, setValue] = useState(() => readRoomNotificationDefault(roomId)), [previous, setPrevious] = useState(value), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [, redraw] = useState(0);
  useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  if (!canEditNotificationDefault(roomId)) return error ? <p className='connect-error' role='alert'>{error}</p> : null;
  return <section className='product-section'><h3>{server ? 'Server notification default' : 'Channel notification default'}</h3><p>Members can override this default in their own notification preferences. Mutes and Do not disturb always apply.</p><form className='dialog-form' onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try { const next = await saveRoomNotificationDefault(roomId, value, previous); setValue(next); setPrevious(next); setSaved(true); await synchronizeNotificationRules(readNotificationPreferences(), server ? { serverId: roomId } : { roomId }); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }}><fieldset disabled={busy}><label>Default notifications<select value={value.mode} onChange={event => setValue({ version: 1, mode: event.target.value as NotificationDefault['mode'] })}><option value='inherit'>{server ? 'Use member preferences' : 'Inherit from server'}</option><option value='all'>All messages</option><option value='mentions'>Mentions only</option><option value='nothing'>Nothing</option></select></label><button className='primary-button'>Save notification default</button><button type='button' className='secondary-button' onClick={() => { const current = readRoomNotificationDefault(roomId); setValue(current); setPrevious(current); setError(''); setSaved(false); }}>Reload notification default</button></fieldset></form>{saved && <p role='status'>Notification default saved.</p>}{error && <p className='connect-error' role='alert'>{error}</p>}</section>;
}
