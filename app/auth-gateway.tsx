import { brandingAsset } from '@/lib/branding';
import { SecurityEnrollment } from './security-enrollment';
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Beer, Loader2, ShieldCheck } from 'lucide-react';
import { requestApi, setManagedAccount, setAccountDevice, type AccountSession } from '@/lib/api';
import './product.css';
import { useInstanceStatus, InstanceNotices } from './instance-status';
import { readInstanceConfig } from '@/lib/instance';
import { pwaUpdateLocked, setPwaReloadAllowed } from '@/lib/pwa';
import { ForcedPasswordChange } from './forced-password-change';

const Tavern = lazy(() => import('./tavern'));
const AdminConsole = lazy(() => import('./admin-console'));
type Config = { bootstrapRequired: boolean; smtpConfigured: boolean; registrationMode?:'admin'|'invite'|'open'|'disabled'; instance?: { name?: string; description?: string; maintenance?: boolean; icon?:string;logo?:string;background?:string;termsUrl?:string;privacyUrl?:string;contact?:string } };
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="product-field"><span>{label}</span>{children}</label>; }
export function AuthGateway() {
  const [config, setConfig] = useState<Config | null>(null), [session, setSession] = useState<AccountSession | null>(null);
  const rechecking=useRef(false);
  const [mode, setMode] = useState('loading'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [remember, setRemember] = useState(false);
  const [challenge, setChallenge] = useState(''), [code, setCode] = useState(''), [method, setMethod] = useState('totp'), [methods, setMethods] = useState<string[]>([]);
  const [email, setEmail] = useState(''), [newPassword, setNewPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [displayName, setDisplayName] = useState(''), [instanceName, setInstanceName] = useState('Tavern'), [description, setDescription] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [notice, setNotice] = useState(''),[recoveryMfa,setRecoveryMfa]=useState('');
  const status=useInstanceStatus(!!config&&['ready','maintenance','login','bootstrap'].includes(mode));
  useEffect(() => { setPwaReloadAllowed(!busy && ['login', 'failure', 'legacy'].includes(mode)); return () => setPwaReloadAllowed(false); }, [mode, busy]);
  useEffect(() => { const reconnect = () => { if (mode === 'failure') void initialize(); }; window.addEventListener('tavern:reconnect', reconnect); return () => window.removeEventListener('tavern:reconnect', reconnect); }, [mode]);
  useEffect(()=>{if(session&&!session.admin&&status?.maintenance.enabled&&mode==='ready'){void import('@/lib/matrix').then(m=>m.clearLocalMatrixSession());setMode('maintenance');}},[status,session,mode]);
  async function openSession(value: AccountSession) {
    setAccountDevice(value.deviceId);
    if (value.passwordChangeRequired) { setSession(value); setPassword(''); setNewPassword(''); setConfirmation(''); setCode(''); setMode('password-change'); return; }
    if(value.mfaEnrollmentRequired){setSession(value);setPassword('');setNewPassword('');setConfirmation('');setCode('');setMode('security-enrollment');return;}
    const health=await requestApi('/system/status').catch(()=>null);
    if(health?.maintenance?.enabled&&!value.admin){setSession(value);setMode('maintenance');return;}
    const { attachManagedMatrixSession } = await import('@/lib/matrix');
    if(!location.pathname.startsWith('/admin'))await attachManagedMatrixSession(value);
    setSession(value); setPassword(''); setNewPassword(''); setConfirmation(''); setCode(''); setMode('ready');
  }
  async function initialize() {
    setMode('loading'); setError('');
    try {
      const value = await requestApi<Config>('/auth/config');
      if (typeof value.bootstrapRequired !== 'boolean') { if((await readInstanceConfig()).managedAuth)throw new Error('The account service returned invalid configuration.');setManagedAccount(false); setMode('legacy'); return; }
      setManagedAccount(true); setConfig(value);
      try { await openSession(await requestApi<AccountSession>('/auth/session')); }
      catch (e: any) { if (e.status !== 401) throw e; setMode(value.bootstrapRequired ? 'bootstrap' : 'login'); }
    } catch (e: any) {
      // Older static deployments have no companion service; preserve their login.
      if (e.status === 404) { setManagedAccount(false); setMode('legacy'); }
      else { setError(e.message); setMode('failure'); }
    }
  }
  useEffect(() => { void initialize(); const logout = () => { setSession(null); setMode('login'); setNotice('You have been signed out.'); }; window.addEventListener('tavern:signout', logout); return () => window.removeEventListener('tavern:signout', logout); }, []);
  useEffect(()=>{const enforce=()=>{if(rechecking.current)return;rechecking.current=true;setMode('loading');void import('@/lib/matrix').then(matrix=>{matrix.clearLocalMatrixSession();return requestApi<AccountSession>('/auth/session');}).then(openSession).catch(e=>{setError(e.message);setMode(e.status===401?'login':'failure');}).finally(()=>{rechecking.current=false;});};window.addEventListener('tavern:account-requirement',enforce);return()=>window.removeEventListener('tavern:account-requirement',enforce);},[]);
  useEffect(()=>{const icon=brandingAsset(config?.instance?.icon);if(!icon)return;const link=document.querySelector<HTMLLinkElement>('link[rel="icon"]')||document.createElement('link'),previous=link.getAttribute('href'),previousType=link.getAttribute('type');link.rel='icon';link.type='image/png';link.href=icon;if(!link.isConnected)document.head.append(link);return()=>{if(previous)link.setAttribute('href',previous);else link.remove();if(previousType)link.setAttribute('type',previousType);else link.removeAttribute('type');};},[config?.instance?.icon]);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (pwaUpdateLocked()) { setError('An app update is being applied. Please wait.'); return; } setPwaReloadAllowed(false); setBusy(true); setError(''); setNotice('');
    try {
      if(mode==='register'){
        const result=await requestApi('/auth/register/start',{inviteToken:new URLSearchParams(location.search).get('invite')||undefined,username,password:newPassword,confirmation,email,displayName});setChallenge(result.challengeId);setNewPassword('');setConfirmation('');setMode('register-code');setNotice('Check your email for the verification code.');
      } else if(mode==='register-code'){
        const result=await requestApi('/auth/register/complete',{challengeId:challenge,code});await openSession(result);if(result.invitationRoomId)location.hash='room='+encodeURIComponent(result.invitationRoomId);
      } else if (mode === 'login') {
        const result = await requestApi('/auth/login', { username, password, remember });
        setPassword('');
        if (result.mfaRequired) { setChallenge(result.challengeId); setMethods(result.methods); setMethod(result.methods[0]); setMode('mfa'); }
        else await openSession(result);
      } else if (mode === 'mfa') await openSession(await requestApi('/auth/mfa', { challengeId: challenge, code, method }));
      else if (mode === 'bootstrap') {
        const result = await requestApi('/auth/bootstrap/start', { username: 'admin', password: 'admin', setup: { username, password: newPassword, confirmPassword: confirmation, displayName, email, timezone, instanceName, instanceDescription: description } });
        setChallenge(result.challengeId); setMode('bootstrap-code'); setNotice('Check your email for the administrator verification code.');
      } else if (mode === 'bootstrap-code') {
        await openSession(await requestApi('/auth/bootstrap/complete', { challengeId: challenge, code }));
      } else if (mode === 'recovery') {
        const result = await requestApi('/auth/recovery/start', { email }); setChallenge(result.challengeId); setMode('recovery-code');
        setNotice('If an eligible account matches this email, a recovery code has been sent.');
      } else if (mode === 'recovery-code') {
        await requestApi('/auth/recovery/complete', { challengeId: challenge, code, newPassword, confirmation, mfaCode:recoveryMfa, method });
        setNewPassword(''); setConfirmation(''); setCode(''); setMode('login'); setNotice('Password updated. Sign in with your new password.');
      }
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  if(mode==='maintenance')return <main className='auth-shell'><section className='auth-card'><h1>Tavern is under maintenance</h1><p>{status?.maintenance.message||'Your administrator is performing maintenance. Please try again shortly.'}</p><button className='primary-button' disabled={busy} onClick={()=>{setBusy(true);void openSession(session!).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>Check again</button><a className='secondary-button' href='/admin'>Administration</a>{error&&<p role='alert'>{error}</p>}</section></main>;
  if (mode === 'legacy' || mode === 'ready') return <><InstanceNotices status={status}/><Suspense fallback={<div className="auth-shell" role="status">Opening Tavern…</div>}>{location.pathname.startsWith('/admin') && session ? <AdminConsole session={session}/> : <Tavern />}</Suspense></>;
  if (mode === 'security-enrollment') return <SecurityEnrollment onComplete={async()=>openSession(await requestApi<AccountSession>('/auth/session'))}/>;
  if (mode === 'password-change') return <ForcedPasswordChange onComplete={async () => openSession(await requestApi<AccountSession>('/auth/session'))}/>;
  const setup = mode === 'bootstrap',register=mode==='register', recovery = mode.startsWith('recovery'), verification = mode.endsWith('-code') || mode === 'mfa';
  return <main className="auth-shell" style={brandingAsset(config?.instance?.background)?{backgroundImage:`linear-gradient(#0008,#0008),url(${brandingAsset(config?.instance?.background)})`,backgroundSize:'cover',backgroundPosition:'center'}:undefined}><section className="auth-card">
    <div className="auth-wordmark">{brandingAsset(config?.instance?.logo)||brandingAsset(config?.instance?.icon)?<img src={brandingAsset(config?.instance?.logo)||brandingAsset(config?.instance?.icon)} alt='' width={48} height={48} style={{objectFit:'contain'}}/>:<Beer aria-hidden='true' size={34}/>}<strong>{config?.instance?.name || 'Tavern'}</strong></div>
    <h1>{mode === 'loading' ? 'Opening your Tavern' : setup ? 'Administrator setup' : register ? 'Create your account' : recovery ? 'Recover your account' : verification ? 'Verify your identity' : mode === 'failure' ? 'Unable to connect' : 'Welcome back'}</h1>
    <p>{setup ? 'Create the permanent administrator identity. Setup credentials stop working after verification.' : config?.instance?.description || 'Your people. Your conversations. Your server.'}</p>
    {mode === 'loading' ? <Loader2 className="spin" aria-label="Loading"/> : mode === 'failure' ? <button className="primary-button" onClick={initialize}>Try again</button> : <form className="dialog-form" onSubmit={submit}>
      {(mode === 'login' || setup || register) && <Field label={setup ? 'Administrator username' : 'Username or email'}><input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required maxLength={254}/></Field>}
      {mode === 'login' && <><Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required/></Field><label className="check-label"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)}/>Keep me signed in</label></>}
      {register&&<Field label='Display name'><input value={displayName} onChange={e=>setDisplayName(e.target.value)} required maxLength={100}/></Field>}{setup && <><Field label="Display name"><input value={displayName} onChange={e => setDisplayName(e.target.value)} required maxLength={100}/></Field><Field label="Timezone"><input value={timezone} onChange={e => setTimezone(e.target.value)} required/></Field><Field label="Instance name"><input value={instanceName} onChange={e => setInstanceName(e.target.value)} required maxLength={80}/></Field><Field label="Instance description"><textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={500}/></Field></>}
      {(setup || register || mode === 'recovery') && <Field label="Email"><input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required maxLength={254}/></Field>}
      {(setup || register || mode === 'recovery-code') && <><Field label="New password"><input type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} minLength={12} required/></Field><Field label="Confirm password"><input type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} minLength={12} required/></Field></>}
      {mode === 'mfa' && <Field label="Verification method"><select value={method} onChange={e => { setMethod(e.target.value); setCode(''); }}>{methods.map(m => <option key={m} value={m}>{m === 'totp' ? 'Authenticator app' : m === 'email' ? 'Email code' : 'Recovery code'}</option>)}</select></Field>}
      {verification && <Field label={method === 'recovery' && mode === 'mfa' ? 'Recovery code' : 'Verification code'}><input autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} required maxLength={64}/></Field>}
      {mode==='recovery-code'&&<><Field label='Authenticator or recovery code (if enabled)'><input autoComplete='one-time-code' value={recoveryMfa} onChange={e=>setRecoveryMfa(e.target.value)}/></Field><Field label='Second-factor type'><select value={method} onChange={e=>setMethod(e.target.value)}><option value='totp'>Authenticator app</option><option value='recovery'>Recovery code</option></select></Field></>}{setup && !config?.smtpConfigured && <p role="alert">Configure SMTP in your deployment environment before completing email verification.</p>}
      <button className="primary-button" disabled={busy || (setup && !config?.smtpConfigured)}>{busy ? 'Please wait…' : setup || register ? 'Send verification code' : verification ? 'Verify and continue' : mode === 'recovery' ? 'Send recovery code' : 'Sign in'}</button>
      {mode==='login'&&config?.smtpConfigured&&(config.registrationMode==='open'||(config.registrationMode==='invite'&&new URLSearchParams(location.search).has('invite')))&&<button type='button' className='secondary-button' onClick={()=>{setMode('register');setError('');}}>Create an account</button>}{mode === 'login' && config?.smtpConfigured && <button type="button" className="text-button" onClick={() => { setMode('recovery'); setError(''); }}>Forgot password?</button>}
      {!setup && mode !== 'login' && <button type="button" className="text-button" disabled={busy} onClick={() => { setMode(config?.bootstrapRequired ? 'bootstrap' : 'login'); setCode(''); setError(''); }}>Back</button>}
    </form>}
    {error && <p className="connect-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <footer><ShieldCheck size={16}/> Self-hosted conversations with end-to-end encryption</footer><div className='auth-legal-links'>{config?.instance?.termsUrl&&/^https?:\/\//.test(config.instance.termsUrl)&&<a href={config.instance.termsUrl} target='_blank' rel='noreferrer'>Terms</a>}{config?.instance?.privacyUrl&&/^https?:\/\//.test(config.instance.privacyUrl)&&<a href={config.instance.privacyUrl} target='_blank' rel='noreferrer'>Privacy</a>}{config?.instance?.contact&&<span>{config.instance.contact}</span>}</div>
  </section></main>;
}
