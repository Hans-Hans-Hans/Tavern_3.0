import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner, isManagedAccount } from '@/lib/api';
import { getMatrixClient } from '@/lib/matrix';
import { emailHistoryStatus, enablePassphraseHistory, prepareCurrentHistoryBackup, recoverPassphraseHistory,
  setHistoryRecoveryMode, type EmailHistoryStatus, type HistoryRecoveryMode } from '@/lib/email-history';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { historyPreferencesChanged } from '@/lib/history-preferences-events';

const prompted = new WeakSet<object>();

export function HistoryPreferences({ automatic = false, ready, known }: { automatic?: boolean; ready: boolean; known: boolean }) {
  const [status, setStatus] = useState<EmailHistoryStatus | null>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [passphrase, setPassphrase] = useState(''), [confirmation, setConfirmation] = useState('');
  const [protect, setProtect] = useState(false), [message, setMessage] = useState('');
  const client = getMatrixClient(), account = accountArtworkOwner();
  const mounted = useRef(false), initial = useRef(true);
  const current = () => mounted.current && client === getMatrixClient() && account === accountArtworkOwner();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!ready || !isManagedAccount()) return;
    let active = true;
    const refresh = async () => {
      try {
        const value = await emailHistoryStatus();
        if (!active || getMatrixClient() !== client || accountArtworkOwner() !== account) return;
        setStatus(value);
        if (automatic && initial.current && !prompted.has(account) &&
            (value.setupRequired && value.mode !== 'email' || value.mode === 'passphrase' && value.passphraseConfigured && !known)) {
          prompted.add(account); setOpen(true);
        }
        initial.current = false;
      } catch (e) { if (active) setError((e as Error).message); }
    };
    void refresh(); window.addEventListener(historyPreferencesChanged, refresh);
    return () => { active = false; window.removeEventListener(historyPreferencesChanged, refresh); };
  }, [ready, automatic, client, account, known]);
  if (!isManagedAccount()) return null;
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setMessage('');
    try {
      await action(); if (!current()) return;
      const value = await emailHistoryStatus(); if (!current()) return;
      setStatus(value); setPassphrase(''); setConfirmation(''); setProtect(false); setMessage(success);
      window.dispatchEvent(new Event(historyPreferencesChanged));
      if (automatic) setOpen(false);
    } catch (e) { if (current()) setError((e as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  const setup = !!status?.setupRequired || !status?.passphraseConfigured || known;
  const form = <>
    <p>Choose recovery for this account. Off stops automatic recovery prompts. Messages stay end-to-end encrypted, and saved keys and backups are kept.</p>
    {!automatic && <label>History recovery method<select aria-label='History recovery method' value={status?.mode ?? 'off'} disabled={busy || !status} onChange={e => void run(() => setHistoryRecoveryMode(e.target.value as HistoryRecoveryMode), 'History recovery preference saved.')}>
      <option value='off'>Off</option><option value='passphrase'>Passphrase</option><option value='email' disabled={!status?.emailReady}>Email code and account password</option>
    </select></label>}
    {(status?.mode === 'passphrase' || status?.mode === 'off' && status.setupRequired) && <form className='dialog-form' onSubmit={e => {
      e.preventDefault();
      if (setup && passphrase !== confirmation) { setError('The history passphrases do not match.'); return; }
      void run(async () => {
        if (setup) {
          if (passphrase.length < 12 || passphrase.length > 1024) throw new Error('Use a history passphrase of 12 to 1024 characters.');
          if (!known) {
            if (!protect) throw new Error('Confirm which message keys this device can protect.');
            await prepareCurrentHistoryBackup();
            if (!current()) return;
          }
          await enablePassphraseHistory(passphrase);
        } else await recoverPassphraseHistory(passphrase);
      }, setup ? 'Passphrase recovery saved. Keep the passphrase somewhere safe.' : 'History unlocked on this device.');
    }}>
      <h4>{setup ? 'Set a history passphrase' : 'Unlock history with your passphrase'}</h4>
      <p>This is separate from your sign-in password. No email is needed. Tavern cannot reset a forgotten history passphrase.</p>
      <label>History passphrase<input type='password' autoComplete={setup ? 'new-password' : 'off'} minLength={setup ? 12 : undefined} maxLength={1024} required value={passphrase} disabled={busy} onChange={e => setPassphrase(e.target.value)}/></label>
      {setup && <label>Confirm history passphrase<input type='password' autoComplete='new-password' required value={confirmation} disabled={busy} onChange={e => setConfirmation(e.target.value)}/></label>}
      {setup && !known && <label className='check-label'><input type='checkbox' checked={protect} disabled={busy} onChange={e => setProtect(e.target.checked)}/> Protect keys available on this device and future messages. Older locked messages still need their original keys. Existing backups will be kept.</label>}
      <button className='primary-button' disabled={busy || setup && !known && !protect}>{busy ? 'Working…' : setup ? 'Save history passphrase' : 'Unlock history'}</button>
    </form>}
    {status?.mode === 'email' && !status.setupRequired && !automatic && <p>Email recovery is selected. Manage the email package below.</p>}
    {status?.mode === 'off' && !status.setupRequired && <p>History recovery prompts are off for this account. Keep this browser’s data or export your keys before changing devices.</p>}
    {message && <p role='status'>{message}</p>}{error && <p role='alert'>{error}</p>}
  </>;
  if (!automatic) return <section className='settings-section'><h3>Message history recovery</h3>{form}</section>;
  return <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); if (!value) { setPassphrase(''); setConfirmation(''); } } }}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>{setup ? 'Set up your history passphrase' : 'Unlock your message history'}</DialogTitle><DialogDescription>Recover history without depending on email delivery.</DialogDescription></DialogHeader>{form}
    <button className='secondary-button' disabled={busy} onClick={() => { setOpen(false); setPassphrase(''); setConfirmation(''); }}>{setup ? 'Continue without setup' : 'Continue without older history'}</button>
    <button className='text-button' disabled={busy} onClick={() => void run(() => setHistoryRecoveryMode('off'), 'History recovery prompts are off.')}>Turn off recovery prompts</button>
  </DialogContent></Dialog>;
}
