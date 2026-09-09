import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { accountSignedOut, requestApi } from '@/lib/api';
import { clearLocalMatrixSession, getMatrixClient } from '@/lib/matrix';
import { Field } from './auth-gateway';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AssociatedEmailVerification } from './associated-email-verification';

export function AccountSettings() {
  const [security, setSecurity] = useState<any>(null), [sessions, setSessions] = useState<any[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [password, setPassword] = useState(''), [newPassword, setNewPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState(''), [method, setMethod] = useState('totp'), [email, setEmail] = useState('');
  const [action, setAction] = useState(''), [challenge, setChallenge] = useState(''), [secret, setSecret] = useState(''), [uri, setUri] = useState('');
  const [codes, setCodes] = useState<string[]>([]), [deleteConfirmation, setDeleteConfirmation] = useState(''), [erase, setErase] = useState(false);
  const [emailChallenge,setEmailChallenge]=useState(''),[qr,setQr]=useState('');
  useEffect(()=>{let live=true;setQr('');if(uri)void import('qrcode').then(q=>q.toDataURL(uri,{width:240,margin:2,errorCorrectionLevel:'M'})).then(url=>{if(live)setQr(url);}).catch(()=>{});return()=>{live=false;};},[uri]);
  async function refresh() { const [a, b] = await Promise.all([requestApi('/account/security'), requestApi('/account/sessions')]); setSecurity(a); setMethod(old=>old==='recovery'||old==='email'&&a.emailMfaEnabled||old==='totp'&&a.totpEnabled?old:a.totpEnabled?'totp':a.emailMfaEnabled?'email':'totp'); setSessions(b.sessions); setEmail(a.email || ''); }
  useEffect(() => { refresh().catch(e => setError(e.message)); }, []);
  async function run(fn: () => Promise<any>, message?: string, preserveInputs=false) {
    setBusy(true); setError('');
    try { const result = await fn(); if (message) toast.success(message); if(!preserveInputs){setPassword(''); setNewPassword(''); setConfirmation(''); setCode(''); await refresh().catch(e=>setError('Change completed, but refreshing settings failed: '+e.message));} return result; }
    catch (e: any) { setError(e.message); return null; } finally { setBusy(false); }
  }
  const auth = { password, code, method, challengeId:emailChallenge };
  const sensitive = <><Field label="Current password"><input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required/></Field>{(security?.totpEnabled || security?.emailMfaEnabled) && <><Field label="Verification method"><select value={method} onChange={e => setMethod(e.target.value)}>{security.totpEnabled && <option value="totp">Authenticator app</option>}{security.emailMfaEnabled && <option value="email">Email</option>}<option value="recovery">Recovery code</option></select></Field>{method==='email'&&<button type='button' className='secondary-button' disabled={busy} onClick={()=>void run(()=>requestApi('/account/security/email-code',{}),'Verification code sent',true).then(r=>{if(r)setEmailChallenge(r.challengeId);})}>Send email code</button>}<Field label="Verification code"><input autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} required/></Field></>}</>;
  return <div className="product-section"><h3>Account security</h3>{error && <p className="connect-error" role="alert">{error}</p>}
    {!security ? <p role="status">Loading account security…</p> : <>
      <form className="dialog-form" onSubmit={e => { e.preventDefault(); void run(() => requestApi('/account/password', { currentPassword: password, newPassword, confirmation, logoutOtherDevices: true, code, method, challengeId:emailChallenge }), 'Password changed. Other devices were signed out.'); }}>
        <h3>Change password</h3>{sensitive}<Field label="New password"><input type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={e => setNewPassword(e.target.value)}/></Field><Field label="Confirm new password"><input type="password" autoComplete="new-password" minLength={12} required value={confirmation} onChange={e => setConfirmation(e.target.value)}/></Field>
        <p>Your encryption recovery key stays the same. Other devices will need to sign in again.</p><button className="primary-button" disabled={busy}>Change password</button>
      </form>
      <hr className="product-divider"/><h3>Email</h3><p>{security.email || 'No email address added'} · {security.emailVerified ? 'Verified' : 'Not verified'}</p><button className="secondary-button" onClick={() => { setAction('email'); setError(''); }}>Change or verify email</button>
      {security.email && !security.emailVerified && <AssociatedEmailVerification key={security.email} email={security.email} onVerified={refresh} />}
      <hr className="product-divider"/><h3>Two-step verification</h3><p>Authenticator app: {security.totpEnabled ? 'Enabled' : 'Disabled'}<br/>Email verification: {security.emailMfaEnabled ? 'Enabled' : 'Disabled'}<br/>Recovery codes remaining: {security.recoveryCodesRemaining}</p>
      <div className="product-actions">{!security.totpEnabled && <button className="secondary-button" onClick={() => setAction('totp')}>Set up authenticator</button>}{!security.emailMfaEnabled && security.emailVerified && <button className="secondary-button" onClick={() => setAction('email-mfa')}>Enable email verification</button>}{(security.totpEnabled || security.emailMfaEnabled) && <><button className="secondary-button" onClick={() => setAction('recovery-codes')}>Generate new recovery codes</button><button className="secondary-button" onClick={() => setAction('disable-mfa')}>Disable two-step verification</button></>}</div>
      <hr className="product-divider"/><h3>Devices & sessions</h3><p>Sessions use secure cookies. Revoking a session stops its access to this instance.</p>
      {sessions.map(s => <div className="device-row" key={s.id}><span><strong>{s.name || s.deviceId}{s.current ? ' · This session' : ''}</strong><small>Created {new Date(s.createdAt * (s.createdAt < 1e12 ? 1000 : 1)).toLocaleString()}<br/>Last used {new Date(s.lastSeen * (s.lastSeen < 1e12 ? 1000 : 1)).toLocaleString()}{s.ip ? ' · ' + s.ip : ''}</small></span>{!s.current && <button className="secondary-button" disabled={busy} onClick={() => setAction('revoke:' + s.id)}>Revoke</button>}</div>)}
      <button className="secondary-button" disabled={busy || sessions.filter(s => !s.current).length === 0} onClick={() => setAction('revoke-others')}>Sign out all other devices</button>
      <hr className="product-divider"/><h3>Account export</h3><p>Download your profile, settings, memberships, and device metadata. Export message history and encryption keys separately in Privacy.</p><a className="secondary-button" href="/api/account/export" download>Download my account data</a><hr className="product-divider"/><h3>Delete account</h3><p>Deactivate your account and revoke its sessions. Recipients and backups may retain historical messages.</p><button className="secondary-button danger-text" onClick={() => { setAction('delete'); setDeleteConfirmation(''); }}>Delete my account…</button>
    </>}
    <Dialog open={!!action} onOpenChange={open => { if (!open && !busy) { setAction(''); setSecret(''); setUri(''); setPassword(''); setCode(''); } }}><DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>{action === 'email' ? 'Verify email' : action === 'totp' ? 'Set up authenticator' : action === 'totp-code' ? 'Verify authenticator' : action === 'email-code' ? 'Verify email code' : action === 'delete' ? 'Delete your account?' : action === 'revoke-others' ? 'Sign out other devices?' : action.startsWith('revoke:') ? 'Revoke this session?' : action==='recovery-codes'?'Replace all recovery codes?':action === 'disable-mfa' ? 'Disable two-step verification?' : 'Enable email verification'}</DialogTitle><DialogDescription>{action === 'delete' ? 'This cannot be undone. Save your encryption recovery key and export any data you need before continuing.' : 'Confirm this change to your account security.'}</DialogDescription></DialogHeader>
      <form className="dialog-form" onSubmit={async e => {
        e.preventDefault();
        if (action === 'email') { const r = await run(() => requestApi('/account/email/start', { email, ...auth })); if (r) { setChallenge(r.challengeId); setAction('email-code'); } }
        else if (action === 'email-code') { if (await run(() => requestApi('/account/email/complete', { challengeId: challenge, code }), 'Email verified')) setAction(''); }
        else if (action === 'totp') { const r = await run(() => requestApi('/account/mfa/totp/start', auth)); if (r) { setChallenge(r.challengeId); setSecret(r.secret); setUri(r.uri); setAction('totp-code'); } }
        else if (action === 'totp-code') { const r = await run(() => requestApi('/account/mfa/totp/complete', { challengeId: challenge, code }), 'Authenticator enabled'); if (r) { setCodes(r.recoveryCodes || []); setSecret(''); setUri(''); setAction(''); } }
        else if (action === 'email-mfa') { const r = await run(() => requestApi('/account/mfa/email', { enabled: true, ...auth }), 'Email verification enabled'); if (r) { setCodes(r.recoveryCodes || []); setAction(''); } }
        else if(action==='recovery-codes'){const r=await run(()=>requestApi('/account/mfa/recovery-codes',auth),'Old recovery codes replaced');if(r){setCodes(r.recoveryCodes||[]);setAction('');}}
        else if (action === 'disable-mfa') { if (await run(() => requestApi('/account/mfa/disable', auth), 'Two-step verification disabled')) setAction(''); }
        else if (action.startsWith('revoke:')) { if (await run(() => requestApi('/account/sessions/' + encodeURIComponent(action.slice(7)), undefined, 'DELETE'), 'Session revoked')) setAction(''); }
        else if (action === 'revoke-others') { if (await run(() => requestApi('/account/sessions/revoke-others', auth), 'Other sessions revoked')) setAction(''); }
        else if (action === 'delete') { setBusy(true); setError(''); try { await requestApi('/account/deactivate', { ...auth, confirmation: deleteConfirmation, erase }); clearLocalMatrixSession(); accountSignedOut(); } catch (err: any) { setError(err.message); } finally { setBusy(false); } }
      }}>
        {!action.endsWith('-code') && !action.startsWith('revoke:') && sensitive}
        {action === 'email' && <Field label="Email address"><input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}/></Field>}
        {action === 'totp-code' && <><p>Add an account in your authenticator using this setup key. Store it privately.</p>{qr&&<img src={qr} width={240} height={240} alt='Scan with your authenticator app'/>}<code>{secret}</code><a href={uri}>Open authenticator app</a></>}
        {action.endsWith('-code') && <Field label="Verification code"><input autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} required/></Field>}
        {action === 'delete' && <><Field label={'Type ' + getMatrixClient()?.getUserId() + ' to confirm'}><input value={deleteConfirmation} onChange={e => setDeleteConfirmation(e.target.value)} required/></Field><label className="check-label"><input type="checkbox" checked={erase} onChange={e => setErase(e.target.checked)}/>Request removal of profile information</label></>}
        {error && <p className="connect-error" role="alert">{error}</p>}<button className={'primary-button ' + (action === 'delete' ? 'delete-confirm' : '')} disabled={busy}>{busy ? 'Please wait…' : action === 'delete' ? 'Permanently deactivate account' : 'Confirm'}</button>
      </form>
    </DialogContent></Dialog>
    <Dialog open={codes.length > 0} onOpenChange={open => { if (!open) setCodes([]); }}><DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>Save your recovery codes</DialogTitle><DialogDescription>Each code works once. Store them somewhere private. They will not be shown again.</DialogDescription></DialogHeader><div className="recovery-codes">{codes.map(c => <code key={c}>{c}</code>)}</div><button className="secondary-button" onClick={() => navigator.clipboard.writeText(codes.join('\n')).then(() => toast.success('Recovery codes copied')).catch(() => toast.error('Copy failed; save the displayed codes manually.'))}>Copy recovery codes</button><button className="primary-button" onClick={() => setCodes([])}>I saved my codes</button></DialogContent></Dialog>
  </div>;
}
