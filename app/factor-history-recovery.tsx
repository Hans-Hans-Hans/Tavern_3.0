import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient } from '@/lib/matrix';
import { enableFactorHistory, recoverFactorHistory, startFactorHistory, prepareCurrentHistoryBackup, setHistoryRecoveryMethods, type EmailHistoryStatus, type HistoryFactor } from '@/lib/email-history';
import { historyPreferencesChanged } from '@/lib/history-preferences-events';

export function FactorHistoryRecovery({ method, status, known, onUnlocked, onSaved }: { method: HistoryFactor; status: EmailHistoryStatus; known: boolean; onUnlocked?: () => void; onSaved?: (onlyMethod: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [challenge, setChallenge] = useState(''), [code, setCode] = useState(''), [password, setPassword] = useState(''), [protect, setProtect] = useState(false);
  const [availableKeysOnly, setAvailableKeysOnly] = useState(false);
  const client = getMatrixClient(), account = accountArtworkOwner(), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && client === getMatrixClient() && account === accountArtworkOwner();
  const configured = !!status.factorConfigured?.[method], setup = known || !configured;
  const recoverFirst = setup && !known && (status.passphraseConfigured || status.configured || Object.values(status.factorConfigured ?? {}).some(Boolean));
  const blocked = recoverFirst && !availableKeysOnly;
  const available = method === 'totp' ? status.authenticatorReady : status.emailReady;
  const name = method === 'totp' ? 'Authenticator app' : 'Email code';
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (e) { if (current()) setError((e as Error).message); }
    finally { if (current()) setBusy(false); }
  }
  return <section aria-label={`${name} history recovery`} className='settings-section'>
    <h4>{name} history recovery</h4>
    <p>{method === 'totp' ? 'Use the six-digit code from your authenticator. The app generates codes without internet or email. If you just used a code to sign in, wait for the next code.' : 'Use a code sent to your verified email. Once set up, no separate history passphrase or old account password is needed.'}</p>
    <p>Tavern keeps a server-protected recovery key for this method. The server can recover history; this is not a passphrase-only privacy guarantee.</p>
    {!available && <p>{method === 'totp' ? 'Set up an authenticator in Account security first.' : 'Verify your email in Account security and enable server email delivery first.'}</p>}
    {configured && <p>{known ? 'Enabled for your account and other devices.' : 'Ready to unlock history on this device.'}</p>}
    {blocked && <><p>You can recover older history first, or set up this method for the keys available on this device and future messages without the old history passphrase.</p><button className='secondary-button' disabled={busy || !available} onClick={() => setAvailableKeysOnly(true)}>Set up {name.toLowerCase()} without the old history passphrase</button></>}
    {availableKeysOnly && <p>This will select {name.toLowerCase()} as your only history recovery method. Existing backups and saved recovery packages are kept. Older locked messages will stay locked unless you later recover their original keys.</p>}
    {!blocked && <form className='dialog-form' onSubmit={e => { e.preventDefault(); void run(async () => {
      if (!challenge) {
        const id = await startFactorHistory(method, setup ? 'save' : 'recover');
        if (current()) { setChallenge(id); setMessage(method === 'email' ? 'Email code sent.' : 'Enter a fresh authenticator code.'); }
        return;
      }
      if (setup) {
        if (!known) {
          if (!protect) throw new Error('Confirm which message keys this device can protect.');
          await prepareCurrentHistoryBackup(); if (!current()) return;
        }
        await enableFactorHistory(method, challenge, code, password);
        if (!current()) return;
        if (availableKeysOnly) await setHistoryRecoveryMethods([method]);
      } else await recoverFactorHistory(method, challenge, code);
      if (!current()) return;
      setCode(''); setPassword(''); setChallenge(''); setProtect(false);
      setMessage(setup ? `${name} history recovery saved.` : 'History unlocked on this device.');
      window.dispatchEvent(new Event(historyPreferencesChanged));
      if (!setup) onUnlocked?.(); else onSaved?.(availableKeysOnly);
    }); }}>
      {setup && <label>Current account password<input type='password' autoComplete='current-password' required disabled={busy} value={password} onChange={e => setPassword(e.target.value)}/></label>}
      {setup && !known && <label className='check-label'><input type='checkbox' checked={protect} disabled={busy} onChange={e => setProtect(e.target.checked)}/> Protect available keys and future messages. Missing older keys still need their original backup or device.</label>}
      {challenge && <label>{name} verification code<input autoComplete='one-time-code' inputMode='numeric' pattern='[0-9]{6}' maxLength={6} required disabled={busy} value={code} onChange={e => setCode(e.target.value)}/></label>}
      <button className='secondary-button' disabled={busy || !available || setup && !known && !protect}>{busy ? 'Working...' : !challenge ? method === 'email' ? 'Send history verification code' : 'Use authenticator code' : setup ? `Save ${name.toLowerCase()} recovery` : `Unlock history with ${name.toLowerCase()}`}</button>
      {challenge && <button type='button' className='text-button' disabled={busy} onClick={() => { setChallenge(''); setCode(''); setError(''); }}>Start verification again</button>}
    </form>}
    {message && <p role='status'>{message}</p>}{error && <p role='alert'>{error}</p>}
  </section>;
}
