import { useEffect, useRef, useState } from 'react';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { readOwnProfile, saveOwnProfile } from '@/lib/community';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ImageEditor } from './community-settings';
const namespace = 'io.tavern.onboarding';
export const openWelcomeTour = () => window.dispatchEvent(new Event('tavern:welcome'));

export function WelcomeTour({ onCreateServer, onInvitations, invitations, onChanged }: { onCreateServer: () => void; onInvitations: () => void; invitations: number; onChanged: () => Promise<unknown> }) {
  const client = getMatrixClient();
  const [open, setOpen] = useState(false), [step, setStep] = useState(0);
  const manual = useRef(false), active = useRef(false);
  const [profile, setProfile] = useState(() => { const profile = readOwnProfile(); return { ...profile, timezone: profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, language: profile.language || navigator.language }; });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    active.current = true; manual.current = false; let initialized = false;
    const sync = () => {
      if (getMatrixClient() !== client || !client?.isInitialSyncComplete()) return;
      const saved = client.getAccountData(namespace as any)?.getContent();
      if (!initialized) {
        initialized = true; setStep(Math.max(0, Math.min(3, Number(saved?.step) || 0)));
        setOpen(manual.current || saved?.completed !== true);
        setProfile(current => ({ ...current, ...readOwnProfile() }));
      } else if (saved?.completed === true && !manual.current) setOpen(false);
    };
    const show = () => { manual.current = true; setOpen(true); setError(''); };
    const unsubscribe = onMatrixUpdate(sync); sync(); window.addEventListener('tavern:welcome', show);
    return () => { active.current = false; unsubscribe(); window.removeEventListener('tavern:welcome', show); };
  }, [client]);
  const owned = () => active.current && getMatrixClient() === client;
  async function saveProfile() {
    if (!client || !owned() || busy) return; setBusy(true); setError('');
    try {
      await saveOwnProfile(profile); if (!owned()) return;
      await onChanged(); if (!owned()) return;
      await client.setAccountData(namespace as any, { version: 1, step: 2, completed: false } as any);
      if (owned()) setStep(2);
    } catch (e) { if (owned()) setError((e as Error).message); }
    finally { if (owned()) setBusy(false); }
  }
  async function advance(next: number, completed = false, action?: () => void) {
    if (!client || !owned() || busy) return; setBusy(true); setError('');
    try { await client.setAccountData(namespace as any, { version: 1, step: next, completed } as any); if (!owned()) return; setStep(next); if (completed || action) { manual.current = false; setOpen(false); } action?.(); }
    catch (e) { if (owned()) setError((e as Error).message); } finally { if (owned()) setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) void advance(step, true); }}><DialogContent className='tavern-dialog welcome-tour'><DialogHeader><DialogTitle>{['Welcome to Tavern', 'Make your profile yours', 'Find your people', 'You’re ready'][step]}</DialogTitle><DialogDescription>{['A few quick steps to settle in. You can skip optional steps and return to this tour from Settings.', 'Choose the name and picture people see in your conversations.', 'Accept an invitation or create a server for your community.', 'A few shortcuts help you move around quickly.'][step]}</DialogDescription></DialogHeader><p className='login-help'>Step {step + 1} of 4</p>
    {step === 0 && <><p>Your conversations and attachments use end-to-end encryption in new rooms. Set up key recovery in Privacy settings so another device can recover your history.</p><p>Profiles, membership, and room information are visible to your homeserver.</p><button className='primary-button' disabled={busy} onClick={() => void advance(1)}>Set up my profile</button></>}
    {step === 1 && <form className='dialog-form' onSubmit={event => { event.preventDefault(); void saveProfile(); }}><fieldset disabled={busy}><label>Display name<input required maxLength={60} value={profile.name} onChange={e => setProfile({ ...profile, name: e.target.value })}/></label><ImageEditor label='Avatar' value={profile.avatar} onChange={avatar => setProfile(current => ({ ...current, avatar }))}/><label>Status (optional)<input maxLength={160} value={profile.status} onChange={e => setProfile({ ...profile, status: e.target.value })}/></label><label>Timezone<input required maxLength={80} value={profile.timezone} onChange={e => setProfile({ ...profile, timezone: e.target.value })}/></label><button className='primary-button'>Save and continue</button></fieldset><button type='button' className='secondary-button' disabled={busy} onClick={() => void advance(2)}>Skip profile for now</button></form>}
    {step === 2 && <><div className='product-actions'>{invitations > 0 && <button className='primary-button' disabled={busy} onClick={() => void advance(3, false, onInvitations)}>Review {invitations} invitation{invitations === 1 ? '' : 's'}</button>}<button className='secondary-button' disabled={busy} onClick={() => void advance(3, false, onCreateServer)}>Create a server</button></div><p>You can also ask a server owner for an invitation link.</p><button className='primary-button' disabled={busy} onClick={() => void advance(3)}>Continue to the tour</button></>}
    {step === 3 && <><ul><li><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> switches conversations.</li><li><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>F</kbd> searches your decrypted history.</li><li>Right-click a message, member, or channel for its actions.</li><li>Reply in a thread to keep a discussion together.</li><li>Settings contains profiles, notifications, device verification, and key recovery.</li></ul><button className='primary-button' disabled={busy} onClick={() => void advance(3, true)}>Start using Tavern</button></>}
    {step > 0 && <button className='text-button' disabled={busy} onClick={() => void advance(step - 1)}>Back</button>}<button className='text-button' disabled={busy} onClick={() => void advance(step, true)}>Finish later</button>{error && <p className='connect-error' role='alert'>{error}</p>}
  </DialogContent></Dialog>;
}
