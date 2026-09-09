import { useEffect, useState } from 'react';
import { accountSignedOut, requestApi } from '@/lib/api';
import { Field } from './auth-gateway';

export function SecurityEnrollment({ onComplete }: { onComplete: () => Promise<unknown> }) {
  const [password, setPassword] = useState(''), [challenge, setChallenge] = useState(''), [secret, setSecret] = useState(''), [uri, setUri] = useState(''), [qr, setQr] = useState(''), [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let live = true; if (uri) void import('qrcode').then(value => value.toDataURL(uri, { width: 240, margin: 2, errorCorrectionLevel: 'M' })).then(value => { if (live) setQr(value); }).catch(() => {}); return () => { live = false; }; }, [uri]);
  async function submit() {
    setBusy(true); setError('');
    try {
      if (!challenge) { const value = await requestApi('/account/mfa/totp/start', { password }); setPassword(''); setChallenge(value.challengeId); setSecret(value.secret); setUri(value.uri); }
      else { const value = await requestApi('/account/mfa/totp/complete', { challengeId: challenge, code }); setCodes(value.recoveryCodes); setSecret(''); setUri(''); setQr(''); setCode(''); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <main className='auth-shell'><section className='auth-card'><h1>Protect your account</h1><p>This instance requires two-step verification before you can continue. Set up an authenticator app and save your recovery codes.</p>
    {codes.length ? <><h2>Save your recovery codes</h2><p>Each code works once. These codes will not be shown again.</p><div className='recovery-codes'>{codes.map(value => <code key={value}>{value}</code>)}</div><button className='secondary-button' onClick={() => void navigator.clipboard.writeText(codes.join('\n')).catch(() => setError('Copy failed. Save the displayed codes manually.'))}>Copy recovery codes</button><button className='primary-button' disabled={busy} onClick={() => { setBusy(true); void onComplete().catch(e => setError(e.message)).finally(() => setBusy(false)); }}>I saved my codes — continue</button></> : <form className='dialog-form' onSubmit={event => { event.preventDefault(); void submit(); }}><fieldset disabled={busy}>
      {!challenge ? <Field label='Current password'><input required type='password' autoComplete='current-password' value={password} onChange={event => setPassword(event.target.value)}/></Field> : <>{qr && <img src={qr} width={240} height={240} alt='Scan with your authenticator app'/>}<p>Add this account in your authenticator, or enter the setup key manually.</p><code>{secret}</code><a href={uri}>Open authenticator app</a><Field label='Authenticator code'><input required autoComplete='one-time-code' inputMode='numeric' pattern='[0-9]{6}' value={code} onChange={event => setCode(event.target.value)}/></Field></>}
      <button className='primary-button'>{challenge ? 'Enable two-step verification' : 'Set up authenticator'}</button></fieldset></form>}
    <button className='text-button' disabled={busy} onClick={() => { setBusy(true); void requestApi('/auth/logout', {}).then(accountSignedOut).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>Sign out</button>{error && <p className='connect-error' role='alert'>{error}</p>}
  </section></main>;
}
