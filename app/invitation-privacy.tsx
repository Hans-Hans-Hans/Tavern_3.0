import { useEffect, useState } from 'react';
import { requestApi } from '@/lib/api';

type InvitationMode = 'everyone' | 'contacts' | 'shared_server' | 'nobody';
type Settings = { invitations: InvitationMode };

export function ConversationInvitationPrivacy() {
  const [saved, setSaved] = useState<InvitationMode | null>(null), [mode, setMode] = useState<InvitationMode>('everyone');
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function load() {
    setBusy(true); setError(''); setNotice('');
    try { const data = await requestApi<Settings>('/social/invitation-privacy'); setSaved(data.invitations); setMode(data.invitations); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function save() {
    setBusy(true); setError(''); setNotice('');
    try { const data = await requestApi<Settings>('/social/invitation-privacy', { invitations: mode }, 'PUT'); setSaved(data.invitations); setMode(data.invitations); setNotice('Conversation invitation privacy saved.'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className='product-section' aria-labelledby='invitation-privacy-title'>
    <h3 id='invitation-privacy-title'>Conversation invitations</h3>
    <p>Choose who can send you new invitations to direct messages, group conversations, channels, and servers. Existing memberships stay active. Blocked people cannot invite you.</p>
    {error && <p className='connect-error' role='alert'>{error}</p>}
    {saved === null ? <><p role='status'>{busy ? 'Loading invitation privacy…' : 'Your saved invitation preference could not be loaded.'}</p><button className='secondary-button' disabled={busy} onClick={() => void load()}>Retry invitation settings</button></> : <>
      <label className='auth-field'>Who can invite you?<select value={mode} disabled={busy} onChange={event => { setMode(event.target.value as InvitationMode); setNotice(''); }}>
        <option value='everyone'>Everyone</option><option value='contacts'>Accepted contacts</option><option value='shared_server'>People sharing a server</option><option value='nobody'>Nobody</option>
      </select></label>
      {mode === 'contacts' && <p>Only people on your accepted contacts list can invite you.</p>}
      {mode === 'shared_server' && <p>You and the inviter must both be current members of at least one server.</p>}
      {mode === 'nobody' && <p>New invitations will be rejected, including server invitation links that invite your account. You can change this preference before using one.</p>}
      <button className='primary-button' disabled={busy || saved === mode} onClick={() => void save()}>{busy ? 'Saving…' : 'Save invitation privacy'}</button>
    </>}{notice && <p role='status'>{notice}</p>}
  </section>;
}
