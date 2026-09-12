import { useEffect, useState } from 'react';
import { accountArtworkOwner, isManagedAccount } from '@/lib/api';
import { getMatrixClient } from '@/lib/matrix';
import { emailHistoryStatus, enableEmailHistory, recoverEmailHistory, startEmailHistory, autoStartEmailHistory, autoEnableEmailHistory, hasHistoryLogin, protectCurrentHistory, type EmailHistoryStatus } from '@/lib/email-history';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
const promptedAccounts = new WeakSet<object>();

export function EmailHistoryRecovery({ known, ready, automatic = false, onConfigured, onChecked, backupVersion }: { known: boolean; ready: boolean; automatic?: boolean; onConfigured?: (value:boolean)=>void; onChecked?: (value:boolean)=>void; backupVersion?: string|null }) {
  const [status,setStatus]=useState<EmailHistoryStatus|null>(null),[open,setOpen]=useState(false),[challenge,setChallenge]=useState('');
  const [protect,setProtect]=useState(false);
  const [password,setPassword]=useState(''),[code,setCode]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const client=getMatrixClient(),account=accountArtworkOwner();
  const current=()=>getMatrixClient()===client&&accountArtworkOwner()===account;
  useEffect(()=>{
    if(!isManagedAccount()||!ready)return;
    let active=true;
    const valid=()=>active&&getMatrixClient()===client&&accountArtworkOwner()===account;
    void emailHistoryStatus().then(async value=>{
      if(!valid())return;setStatus(value);onConfigured?.(value.configured);onChecked?.(true);
      if(!automatic||!value.emailReady)return;
      if(known&&hasHistoryLogin()&&(!value.configured||value.passwordChanged||(backupVersion&&value.backupVersion!==backupVersion))){
        await autoEnableEmailHistory();if(valid()){const refreshed=await emailHistoryStatus();if(!valid())return;setStatus(refreshed);onConfigured?.(refreshed.configured);setMessage('Email history recovery is enabled.');}
      } else if(!known&&value.configured&&!promptedAccounts.has(account)){
        promptedAccounts.add(account);
        setOpen(true);setBusy(true);
        try {const id=await autoStartEmailHistory();if(valid())setChallenge(id);}
        finally {if(valid())setBusy(false);}
      }
    }).catch(e=>{if(valid()){setError(e.message);onChecked?.(true);}});
    return()=>{active=false;};
  },[ready,known,automatic,client,account,onConfigured,onChecked,backupVersion]);
  useEffect(()=>{if(automatic&&known){setOpen(false);setCode('');setPassword('');}},[automatic,known]);
  if(!isManagedAccount())return null;
  async function send() {
    setBusy(true);setError('');
    try {const id=await startEmailHistory();if(current()){setChallenge(id);setCode('');setOpen(true);}}
    catch(e){if(current())setError((e as Error).message);}
    finally{if(current())setBusy(false);}
  }
  return <>
    {!automatic&&<section className='settings-section'><h3>Email history recovery</h3>
      <p>Known browsers reuse their saved message keys. On a new device, sign in with your password and verify an email code to unlock your saved history.</p>
      {status?.configured&&<p role='status'>{status.passwordChanged?'Your password changed. Update the saved package from a device with your history keys.':'Your password-protected history key is saved.'}</p>}
      {!status?.emailReady&&<p>A verified account email and working server email delivery are required.</p>}
      {known&&<form className='dialog-form' onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await enableEmailHistory(password);if(current()){setPassword('');const refreshed=await emailHistoryStatus();if(!current())return;setStatus(refreshed);setMessage('Email history recovery is enabled.');}}catch(e){if(current())setError((e as Error).message);}finally{if(current())setBusy(false);}}}>
        <label>Password for email recovery<input type='password' autoComplete='current-password' value={password} onChange={e=>setPassword(e.target.value)} required={!hasHistoryLogin()}/></label>
        <button className='secondary-button' disabled={busy||!status?.emailReady}>{status?.configured?'Update email recovery':'Enable email recovery'}</button>
      </form>}
      {!known&&status?.configured&&<button className='secondary-button' disabled={busy||!status.emailReady} onClick={()=>void send()}>Unlock with email code</button>}
      {!known&&status&&!status.configured&&<form className='dialog-form' onSubmit={async e=>{e.preventDefault();if(!protect)return;setBusy(true);setError('');try{await protectCurrentHistory(password);const fresh=await emailHistoryStatus();if(current()){setStatus(fresh);setPassword('');setProtect(false);setMessage('Current and future message keys will be backed up for email recovery.');}}catch(e){if(current())setError((e as Error).message);}finally{if(current())setBusy(false);}}}>
        <p>Protect the message keys available on this browser and future messages. Older locked messages still need their original key. Existing backup versions and your encryption identity are preserved.</p>
        <label>Password for email recovery<input type='password' autoComplete='current-password' required value={password} onChange={e=>setPassword(e.target.value)}/></label>
        <label className='check-label'><input type='checkbox' checked={protect} onChange={e=>setProtect(e.target.checked)}/> I understand this protects available keys and cannot recover missing older keys.</label>
        <button className='secondary-button' disabled={busy||!protect||!status.emailReady}>Protect messages on this device</button>
      </form>}
      <p>A password reset does not unlock this package. Keep a known device or an encrypted export of your message keys. Email recovery restores history; verifying someone's identity remains a separate action.</p>
      {message&&<p role='status'>{message}</p>}{error&&<p role='alert'>{error}</p>}
    </section>}
    <Dialog open={open} onOpenChange={value=>{if(!busy){setOpen(value);if(!value){setCode('');setPassword('');}}}}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Unlock your message history</DialogTitle><DialogDescription>Enter the code sent to your verified email. This browser will remember your history keys so you can sign in here again without another recovery code.</DialogDescription></DialogHeader>
      <form className='dialog-form' onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await recoverEmailHistory(challenge,code,password);if(current()){setPassword('');setCode('');setOpen(false);setMessage('Message history unlocked on this browser.');}}catch(e){if(current())setError((e as Error).message);}finally{if(current())setBusy(false);}}}>
        {(!hasHistoryLogin()||status?.passwordChanged||error.includes('password'))&&<label>Password used to protect history<input type='password' autoComplete='current-password' value={password} onChange={e=>setPassword(e.target.value)} required/></label>}
        <label>Email verification code<input autoComplete='one-time-code' inputMode='numeric' pattern='[0-9]{6}' maxLength={6} value={code} onChange={e=>setCode(e.target.value)} required/></label>
        <button className='primary-button' disabled={busy||!challenge}>{busy?'Unlocking...':'Unlock history'}</button>
        <button type='button' className='text-button' disabled={busy} onClick={()=>void send()}>Send a new code</button>
        <button type='button' className='text-button' disabled={busy} onClick={()=>{setOpen(false);setPassword('');setCode('');}}>Continue without older history</button>
        {error&&<p role='alert'>{error}</p>}
      </form>
    </DialogContent></Dialog>
  </>;
}
