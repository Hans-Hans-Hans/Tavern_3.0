import { useState } from 'react';
import { requestApi } from '@/lib/api';

export function AssociatedEmailVerification({ email, onVerified }: { email: string; onVerified: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false), [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <div className='product-section'>
    {!open ? <button className='secondary-button' type='button' onClick={() => setOpen(true)}>Enter administrator-sent email code</button> : <form className='dialog-form' onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { await requestApi('/account/email/pending/complete', { code }); setCode(''); await onVerified(); setOpen(false); }
      catch (e: any) { setError(e.message); } finally { setBusy(false); }
    }}><p>Enter the latest code sent by your administrator to {email}. This verifies the address already on your account.</p><label>Administrator-sent email code<input required inputMode='numeric' autoComplete='one-time-code' pattern='[0-9]{6}' maxLength={6} value={code} onChange={event => setCode(event.target.value)} /></label>
      {error && <p className='connect-error' role='alert'>{error}</p>}
      <div className='product-actions'><button className='primary-button' disabled={busy}>{busy ? 'Verifying email…' : 'Verify associated email'}</button><button className='secondary-button' type='button' disabled={busy} onClick={() => { setOpen(false); setCode(''); setError(''); }}>Cancel</button></div>
    </form>}
  </div>;
}
