import { useEffect, useState } from 'react';
import { VerificationPhase, type GeneratedSecretStorageKey } from 'matrix-js-sdk/lib/crypto-api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { acceptVerification, beginVerification, cancelVerification, confirmVerification, dismissVerification, generateRecoveryKey,
  mismatchVerification, recoverEncryption, securityStatus, setupRecovery, subscribeSecurity, verificationSnapshot } from '@/lib/security';

export function SecurityCenter() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof securityStatus>> | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<GeneratedSecretStorageKey | null>(null);
  const [saved, setSaved] = useState(false), [password, setPassword] = useState(''), [key, setKey] = useState('');
  const [restoreAll, setRestoreAll] = useState(false), [finishSetup, setFinishSetup] = useState(false);
  useEffect(() => { let active = true; const refresh = () => securityStatus().then(s => { if (active) setStatus(s); }).catch(e => { if (active) setError(e.message); }); void refresh(); const off = subscribeSecurity(refresh); return () => { active = false; off(); }; }, []);
  useEffect(() => () => { generated?.privateKey.fill(0); }, [generated]);
  async function run(task: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await task(); setStatus(await securityStatus()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); setPassword(''); setKey(''); } }
  return <section className="session-manager"><h3>Encryption identity & recovery</h3>
    <p className="login-help">Compare devices with emoji verification, or unlock this session with your recovery key. The homeserver stores encrypted key backups; keep the recovery key somewhere you control.</p>
    {status && <dl className="security-status"><div><dt>This device</dt><dd>{status.verified ? 'Verified' : 'Not verified'}</dd></div><div><dt>Signing identity</dt><dd>{status.identity ? 'Ready' : status.serverIdentity ? 'Locked on this device' : 'Not configured'}</dd></div><div><dt>Secret storage</dt><dd>{status.storage ? 'Configured' : 'Setup incomplete'}</dd></div><div><dt>Automatic key backup</dt><dd>{status.backupVersion ? `Active · version ${status.backupVersion}` : 'Not active on this device'}</dd></div></dl>}
    {!generated && <button className="secondary-button" disabled={busy || !status || status.serverIdentity} onClick={() => void run(async () => { setGenerated(await generateRecoveryKey()); setSaved(false); })}>Set up recovery for a new account</button>}
    {generated && <form className="dialog-form" onSubmit={e => { e.preventDefault(); if (!saved) return; void run(async () => { try { await setupRecovery(generated, password); setMessage('Identity created and encrypted key backup enabled.'); } finally { generated.privateKey.fill(0); setGenerated(null); } }); }}>
      <p><strong>Save your recovery key before continuing.</strong> Anyone with this key and account access can recover your encrypted history. Tavern cannot replace a lost key.</p>
      <textarea readOnly aria-label="Recovery key" value={generated.encodedPrivateKey || ''} rows={3} spellCheck={false} />
      <button type="button" className="secondary-button" onClick={() => { const url = URL.createObjectURL(new Blob([`Tavern Matrix recovery key\n\n${generated.encodedPrivateKey}\n`], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = 'tavern-recovery-key.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download recovery key</button>
      <label className="check-label"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} /> I saved this key in a safe place.</label>
      <label>Account password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <div className="inline-actions"><button className="primary-button" disabled={busy || !saved}>{busy ? 'Setting up…' : 'Enable identity & backup'}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => { setGenerated(null); setPassword(''); }}>Cancel</button></div>
    </form>}
    {!generated && <form className="dialog-form" onSubmit={e => { e.preventDefault(); void run(() => recoverEncryption(key, restoreAll, setMessage, finishSetup, password)); }}>
      <label>Existing recovery key<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} required disabled={busy} /></label>
      <label className="check-label"><input type="checkbox" checked={restoreAll} onChange={e => setRestoreAll(e.target.checked)} disabled={busy} /> Restore every available history key now</label>
      <label className="check-label"><input type="checkbox" checked={finishSetup} onChange={e => setFinishSetup(e.target.checked)} disabled={busy} /> Finish interrupted setup or create a missing backup</label>
      {finishSetup && <label>Account password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>}
      <button className="primary-button" disabled={busy || !key.trim()}>{busy ? 'Working…' : 'Unlock & enable automatic recovery'}</button>
    </form>}
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
