import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner, isManagedAccount } from '@/lib/api';
import { getMatrixClient } from '@/lib/matrix';
import { emailHistoryStatus, enablePassphraseHistory, prepareCurrentHistoryBackup, recoverPassphraseHistory,
  setHistoryRecoveryMode, setHistoryRecoveryMethods, type EmailHistoryStatus, type HistoryRecoveryMethod } from '@/lib/email-history';
import { FactorHistoryRecovery } from './factor-history-recovery';
import { EmailHistoryRecovery } from './email-history-recovery';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { historyPreferencesChanged, openHistoryRecovery } from '@/lib/history-preferences-events';

const prompted = new WeakSet<object>();

export function HistoryPreferences({ automatic = false, ready, known }: { automatic?: boolean; ready: boolean; known: boolean }) {
  const [status, setStatus] = useState<EmailHistoryStatus | null>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [passphrase, setPassphrase] = useState(''), [confirmation, setConfirmation] = useState('');
  const [protect, setProtect] = useState(false), [message, setMessage] = useState('');
  const [unlockedAccount, setUnlockedAccount] = useState<object | null>(null);
  const client = getMatrixClient(), account = accountArtworkOwner();
  const canRestore = known || unlockedAccount === account;
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
            (value.setupRequired && value.mode !== 'email' || !known &&
              (value.passphraseConfigured && (value.methods ?? [value.mode]).includes('passphrase') ||
               (['totp', 'email'] as const).some(method => value.methods?.includes(method) && value.factorConfigured?.[method])))) {
          prompted.add(account); setOpen(true);
        }
        initial.current = false;
      } catch (e) { if (active) setError((e as Error).message); }
    };
    void refresh(); window.addEventListener(historyPreferencesChanged, refresh);
    return () => { active = false; window.removeEventListener(historyPreferencesChanged, refresh); };
  }, [ready, automatic, client, account, known]);
  if (!isManagedAccount()) return null;
  async function run(action: () => Promise<unknown>, success: string, closeAfter = true) {
    setBusy(true); setError(''); setMessage('');
    try {
      await action(); if (!current()) return;
      const value = await emailHistoryStatus(); if (!current()) return;
      setStatus(value); setPassphrase(''); setConfirmation(''); setProtect(false); setMessage(success);
      window.dispatchEvent(new Event(historyPreferencesChanged));
      if (automatic && closeAfter) setOpen(false);
    } catch (e) { if (current()) setError((e as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  const setup = !status?.passphraseConfigured || canRestore;
  const recoverFirst = !canRestore && setup && (!!status?.configured || Object.values(status?.factorConfigured ?? {}).some(Boolean));
  const methods = status?.methods ?? (status?.mode && status.mode !== 'off' ? [status.mode] : []);
  const pendingFactors = methods.filter((method): method is 'totp' | 'email' => method !== 'passphrase' && !status?.factorConfigured?.[method]);
  const needsExistingRecovery = !canRestore && pendingFactors.length > 0 &&
    (status?.passphraseConfigured || status?.configured || Object.values(status?.factorConfigured ?? {}).some(Boolean));
  function historyUnlocked() {
    if (!current()) return;
    setUnlockedAccount(account);
    if (automatic && !pendingFactors.length) setOpen(false);
  }
  function changeMethods(next: HistoryRecoveryMethod[]) {
    const previous = status;
    if (status) setStatus({ ...status, methods: next });
    void run(async () => {
      try { await setHistoryRecoveryMethods(next); }
      catch (e) { if (current()) setStatus(previous); throw e; }
    }, 'History recovery preference saved.', false);
  }
  const form = <>
    <p>Choose any combination for this account. Each enabled method unlocks history independently after sign-in. Your choices follow you across browsers and devices.</p>
    {!automatic && <fieldset disabled={busy || !status}><legend>History recovery methods</legend>{(['passphrase', 'totp', 'email'] as HistoryRecoveryMethod[]).map(method => <label className='check-label' key={method}><input type='checkbox' checked={methods.includes(method)} disabled={method === 'email' && !status?.emailReady && !methods.includes(method)} onChange={e => changeMethods(e.target.checked ? [...methods, method] : methods.filter(value => value !== method))}/>{method === 'passphrase' ? 'Use history passphrase' : method === 'totp' ? 'Authenticator app' : 'Email code'}</label>)}</fieldset>}
    {needsExistingRecovery && <section aria-label='Recover existing history'>
      <h4>Recover existing history first</h4>
      <p>Your saved history needs its original recovery key before another method can unlock it. Recover it here, then finish authenticator or email setup in this dialog.</p>
      {status?.passphraseConfigured && !methods.includes('passphrase') && <button className='secondary-button' disabled={busy} onClick={() => changeMethods([...methods, 'passphrase'])}>Use existing history passphrase</button>}
      {status?.emailReady && (status.configured || status.factorConfigured?.email) && !methods.includes('email') && <button className='secondary-button' disabled={busy} onClick={() => changeMethods([...methods, 'email'])}>Use existing email recovery</button>}
      {status?.factorConfigured?.totp && !methods.includes('totp') && <button className='secondary-button' disabled={busy} onClick={() => changeMethods([...methods, 'totp'])}>Use existing authenticator recovery</button>}
      <button className='secondary-button' disabled={busy} onClick={() => { setOpen(false); setPassphrase(''); setConfirmation(''); window.dispatchEvent(new Event(openHistoryRecovery)); }}>Use a recovery key, key file, or another device</button>
      <p>Re-enabling an existing method adds it to your account's recovery choices. If you have lost every original key and recovery method, entering your account password or a new authenticator code cannot recreate older history.</p>
    </section>}
    {(methods.includes('passphrase') || !methods.length && status?.setupRequired) && <form className='dialog-form' onSubmit={e => {
      e.preventDefault();
      if (setup && passphrase !== confirmation) { setError('The history passphrases do not match.'); return; }
      void run(async () => {
        if (setup) {
          if (recoverFirst) throw new Error('Unlock existing history with another enabled method or a known device before adding a passphrase.');
          if (passphrase.length < 12 || passphrase.length > 1024) throw new Error('Use a history passphrase of 12 to 1024 characters.');
          if (!canRestore) {
            if (!protect) throw new Error('Confirm which message keys this device can protect.');
            await prepareCurrentHistoryBackup();
            if (!current()) return;
          }
          await enablePassphraseHistory(passphrase);
        } else { await recoverPassphraseHistory(passphrase); if (current()) setUnlockedAccount(account); }
      }, setup ? 'Passphrase recovery saved. Keep the passphrase somewhere safe.' : 'History unlocked. You can now finish setting up another recovery method.', setup || !pendingFactors.length);
    }}>
      <h4>{setup ? 'Set a history passphrase' : 'Unlock history with your passphrase'}</h4>
      <p>This is separate from your sign-in password. No email is needed. If forgotten, unlock with another enabled method or a known device, then save a new history passphrase.</p>
      <label>History passphrase<input type='password' autoComplete={setup ? 'new-password' : 'off'} minLength={setup ? 12 : undefined} maxLength={1024} required value={passphrase} disabled={busy} onChange={e => setPassphrase(e.target.value)}/></label>
      {setup && <label>Confirm history passphrase<input type='password' autoComplete='new-password' required value={confirmation} disabled={busy} onChange={e => setConfirmation(e.target.value)}/></label>}
      {recoverFirst && <p>Unlock existing history with another enabled method or a known device before adding a passphrase.</p>}
      {setup && !canRestore && !recoverFirst && <label className='check-label'><input type='checkbox' checked={protect} disabled={busy} onChange={e => setProtect(e.target.checked)}/> Protect keys available on this device and future messages. Older locked messages still need their original keys. Existing backups will be kept.</label>}
      <button className='primary-button' disabled={busy || recoverFirst || setup && !canRestore && !protect}>{busy ? 'Working…' : setup ? 'Save history passphrase' : 'Unlock history'}</button>
    </form>}
    {status && methods.includes('totp') && <FactorHistoryRecovery method='totp' status={status} known={canRestore} onUnlocked={historyUnlocked} onSaved={onlyMethod => { if (automatic && (onlyMethod || pendingFactors.every(method => method === 'totp'))) setOpen(false); }}/>}
    {status && methods.includes('email') && <FactorHistoryRecovery method='email' status={status} known={canRestore} onUnlocked={historyUnlocked} onSaved={onlyMethod => { if (automatic && (onlyMethod || pendingFactors.every(method => method === 'email'))) setOpen(false); }}/>}
    {needsExistingRecovery && status?.configured && methods.includes('email') && !status.factorConfigured?.email && <EmailHistoryRecovery known={false} ready onUnlocked={historyUnlocked}/>}
    {!methods.length && !status?.setupRequired && <p>History recovery prompts are off for this account. Keep this browser’s data or export your keys before changing devices.</p>}
    {message && <p role='status'>{message}</p>}{error && <p role='alert'>{error}</p>}
  </>;
  if (!automatic) return <section className='settings-section'><h3>Message history recovery</h3>{form}</section>;
  return <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); if (!value) { setPassphrase(''); setConfirmation(''); } } }}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>{setup && !methods.some(method => method !== 'passphrase') ? 'Set up your history passphrase' : 'Unlock your message history'}</DialogTitle><DialogDescription>Use any recovery method enabled for your account.</DialogDescription></DialogHeader>{form}
    <button className='secondary-button' disabled={busy} onClick={() => { setOpen(false); setPassphrase(''); setConfirmation(''); }}>{setup ? 'Continue without setup' : 'Continue without older history'}</button>
    <button className='text-button' disabled={busy} onClick={() => void run(() => setHistoryRecoveryMode('off'), 'History recovery prompts are off.')}>Turn off recovery prompts</button>
  </DialogContent></Dialog>;
}
