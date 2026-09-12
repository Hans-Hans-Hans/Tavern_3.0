import { EmailHistoryRecovery } from './email-history-recovery';
import { useEffect, useRef, useState } from 'react';
import { VerificationPhase, type GeneratedSecretStorageKey } from 'matrix-js-sdk/lib/crypto-api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { importEncryptionKeys } from '@/lib/matrix';
import { acceptVerification, beginVerification, cancelVerification, confirmVerification, dismissVerification, generateRecoveryKey,
  mismatchVerification, recoverEncryption, securityStatus, setupRecovery, subscribeSecurity, verificationSnapshot,
  historyRecoverySnapshot, restoreLocalHistory, securitySessionId } from '@/lib/security';

export function SecurityCenter() {
  const [session, setSession] = useState(securitySessionId);
  useEffect(() => subscribeSecurity(() => setSession(securitySessionId())), []);
  return <SecurityCenterSession key={session}/>;
}
function SecurityCenterSession() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof securityStatus>> | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<GeneratedSecretStorageKey | null>(null);
  const [saved, setSaved] = useState(false), [password, setPassword] = useState(''), [key, setKey] = useState('');
  const [restoreAll, setRestoreAll] = useState(true), [finishSetup, setFinishSetup] = useState(false);
  const [history, setHistory] = useState(historyRecoverySnapshot);
  const [keyFile, setKeyFile] = useState<File | null>(null), [filePassword, setFilePassword] = useState('');
  useEffect(() => subscribeSecurity(() => setHistory(historyRecoverySnapshot())), []);
  useEffect(() => { let active = true; const refresh = () => securityStatus().then(s => { if (active) setStatus(s); }).catch(e => { if (active) setError(e.message); }); void refresh(); const off = subscribeSecurity(refresh); return () => { active = false; off(); }; }, []);
  useEffect(() => () => { generated?.privateKey.fill(0); }, [generated]);
  async function run(task: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await task(); if (mounted.current) { const value = await securityStatus(); if (mounted.current) setStatus(value); } } catch (e) { if (mounted.current) setError((e as Error).message); } finally { if (mounted.current) { setBusy(false); setPassword(''); setKey(''); } } }
  return <section className="session-manager"><EmailHistoryRecovery backupVersion={status?.serverBackupVersion} known={status?.canRestoreBackup===true} ready={!!status&&!history.busy}/><h3>Encryption identity & recovery</h3>
    <p className="login-help">Compare devices with emoji verification, or unlock this session with your recovery key. The homeserver stores encrypted key backups; keep the recovery key somewhere you control.</p>
    {status && <dl className="security-status"><div><dt>This device</dt><dd>{status.verified ? 'Verified' : 'Not verified'}</dd></div><div><dt>Signing identity</dt><dd>{status.identity ? 'Ready' : status.serverIdentity ? 'Locked on this device' : 'Not available on this device'}</dd></div><div><dt>Secret storage</dt><dd>{status.storage ? 'Configured' : 'Setup incomplete'}</dd></div><div><dt>Automatic key backup</dt><dd>{status.backupVersion ? `Active · version ${status.backupVersion}` : 'Not active on this device'}</dd></div></dl>}
    <div className='local-history-recovery'><h4>Earlier sign-ins in this browser</h4><p>{history.busy ? 'Checking saved message keys…' : history.local?.keys ? `Recovered ${history.local.keys} saved message keys. Available messages will decrypt as their keys are loaded.` : history.checked ? 'No message keys recovered from earlier sign-ins in this browser.' : 'Check for saved message keys from an earlier sign-in.'}</p>
      {!!history.local?.skipped && <p>Some saved sessions could not be opened. Close other Tavern tabs and retry in this browser.</p>}
      {history.local?.limited && <p>This browser has more keys than one recovery pass can copy. Keep its saved data and use an encrypted key export for the remaining history.</p>}
      {history.local && !history.local.supported && <p>This browser cannot check older encryption stores automatically. Use a recovery key, verified device or encrypted key file.</p>}
      {history.error && <p role='alert'>{history.error}</p>}
      <button className='secondary-button' disabled={busy || history.busy} onClick={() => void run(restoreLocalHistory)}>Check this browser for history keys</button>
    </div>
    {!generated && <button className="secondary-button" disabled={busy || history.busy || !status || status.serverIdentity || status.recoveryConfigured || !!status.serverBackupVersion} onClick={() => void run(async () => { const value = await generateRecoveryKey(); if (!mounted.current) { value.privateKey.fill(0); return; } setGenerated(value); setSaved(false); })}>Set up a recovery key</button>}
    {status && !status.recoveryConfigured && <p>Setting up recovery protects the keys available on this device. It cannot recreate older keys that no browser, backup or key file retains.</p>}
    {generated && <form className="dialog-form" onSubmit={e => { e.preventDefault(); if (!saved) return; void run(async () => { try { await setupRecovery(generated, password); setMessage('Identity created and encrypted key backup enabled.'); } finally { generated.privateKey.fill(0); setGenerated(null); } }); }}>
      <p><strong>Save your recovery key before continuing.</strong> Anyone with this key and account access can recover your encrypted history. Tavern cannot replace a lost key.</p>
      <textarea readOnly aria-label="Recovery key" value={generated.encodedPrivateKey || ''} rows={3} spellCheck={false} />
      <button type="button" className="secondary-button" onClick={() => { const url = URL.createObjectURL(new Blob([`Tavern Matrix recovery key\n\n${generated.encodedPrivateKey}\n`], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = 'tavern-recovery-key.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download recovery key</button>
      <label className="check-label"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} /> I saved this key in a safe place.</label>
      <label>Account password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <div className="inline-actions"><button className="primary-button" disabled={busy || !saved}>{busy ? 'Setting up…' : 'Enable identity & backup'}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => { setGenerated(null); setPassword(''); }}>Cancel</button></div>
    </form>}
    {!generated && status?.recoveryConfigured && <form className="dialog-form" onSubmit={e => { e.preventDefault(); void run(() => recoverEncryption(key, restoreAll, value => { if (mounted.current) setMessage(value); }, finishSetup, password)); }}>
      <label>Existing recovery key<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} required disabled={busy} /></label>
      <label className="check-label"><input type="checkbox" checked={restoreAll} onChange={e => setRestoreAll(e.target.checked)} disabled={busy} /> Restore every available history key now</label>
      <label className="check-label"><input type="checkbox" checked={finishSetup} onChange={e => setFinishSetup(e.target.checked)} disabled={busy} /> Finish interrupted setup or create a missing backup</label>
      {finishSetup && <label>Account password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>}
      <button className="primary-button" disabled={busy || !key.trim()}>{busy ? 'Working…' : 'Unlock & enable automatic recovery'}</button>
    </form>}
    {!generated && status && !status.recoveryConfigured && (status.serverIdentity || status.serverBackupVersion) && <p>This account already has encryption configured without an available recovery key. Verify with an existing device or import an encrypted key file in Privacy settings. Existing encryption keys will be preserved.</p>}
    <details><summary>Recover from an encrypted key file</summary><form className='dialog-form' onSubmit={event => { event.preventDefault(); if (keyFile) void run(async () => { try { await importEncryptionKeys(keyFile, filePassword); if (mounted.current) setMessage('Saved message keys imported. Available messages will decrypt automatically.'); } finally { if (mounted.current) setFilePassword(''); } }); }}>
      <p>Use a message-key export from Tavern or Element and the passphrase used when it was exported.</p>
      <label>Encrypted key file<input type='file' disabled={busy || history.busy} onChange={event => setKeyFile(event.target.files?.[0] || null)}/></label>
      <label>Key file passphrase<input type='password' autoComplete='off' value={filePassword} disabled={busy || history.busy} onChange={event => setFilePassword(event.target.value)}/></label>
      <button className='secondary-button' disabled={busy || history.busy || !keyFile || !filePassword}>Import saved message keys</button>
    </form></details>
    {message && <p role="status">{message}</p>}{error && <p className="connect-error" role="alert">{error}</p>}
  </section>;
}

export function VerificationDialog() {
  const [snapshot, setSnapshot] = useState(verificationSnapshot), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => subscribeSecurity(() => setSnapshot(verificationSnapshot())), []);
  const { request, sas } = snapshot, phase = request?.phase;
  const finished = phase === VerificationPhase.Done || phase === VerificationPhase.Cancelled;
  async function run(task: () => Promise<void>) { setBusy(true); setError(''); try { await task(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <Dialog open={!!request} onOpenChange={open => { if (!open && !busy) void run(finished ? async () => dismissVerification() : cancelVerification); }}><DialogContent><DialogHeader><DialogTitle>Verify encryption identity</DialogTitle><DialogDescription>Compare with {request?.otherUserId} on device {request?.otherDeviceId || 'selected by the other user'}.</DialogDescription></DialogHeader>
    {phase === VerificationPhase.Requested && !request?.initiatedByMe && <><p>Accept only if you or this person intended to verify now.</p><button className="primary-button" disabled={busy} onClick={() => void run(acceptVerification)}>Accept verification</button></>}
    {phase === VerificationPhase.Requested && request?.initiatedByMe && <p>Waiting for the other device to accept…</p>}
    {phase === VerificationPhase.Ready && <button className="primary-button" disabled={busy} onClick={() => void run(beginVerification)}>Compare emoji</button>}
    {phase === VerificationPhase.Started && !sas && <p>Waiting for the other device to complete verification…</p>}
    {sas && <><p>Do all seven emoji match, in this order, on both devices? Compare over a trusted channel.</p><div className="verification-emoji">{sas.sas.emoji?.map(([emoji, name], i) => <div key={i}><span>{emoji}</span><small>{name}</small></div>)}</div>{sas.sas.decimal && <p className="verification-numbers">{sas.sas.decimal.join(' · ')}</p>}<div className="inline-actions"><button className="primary-button" disabled={busy} onClick={() => void run(()=>confirmVerification(sas))}>They match</button><button className="secondary-button" disabled={busy} onClick={mismatchVerification}>They are different</button></div></>}
    {phase === VerificationPhase.Done && <p role="status">Verification completed by both devices.</p>}
    {phase === VerificationPhase.Cancelled && <p>Verification was cancelled. No match was established.</p>}
    {(error || snapshot.error) && <p className="connect-error" role="alert">{error || snapshot.error}</p>}
    <button className="secondary-button" disabled={busy} onClick={() => void run(finished ? async () => dismissVerification() : cancelVerification)}>{finished ? 'Close' : 'Cancel verification'}</button>
  </DialogContent></Dialog>;
}
