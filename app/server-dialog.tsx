import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { matrixApi } from '@/lib/matrix';
import { terminology, type Naming } from '@/lib/terminology';

export function ServerDialog({ open, naming, onClose, onCreated }: {
  open: boolean; naming: Naming; onClose: () => void; onCreated: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [notificationMode, setNotificationMode] = useState('mentions');
  const [welcome, setWelcome] = useState('');
  const [welcomeEnabled, setWelcomeEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const terms = terminology(naming);
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <DialogContent className="tavern-dialog">
      <DialogHeader><DialogTitle>Create a {terms.server}</DialogTitle>
        <DialogDescription>Organize your conversations around a team, project, or community.</DialogDescription></DialogHeader>
      <form className="dialog-form" onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError('');
        try { const result = await matrixApi('createServer', { name, description, notificationMode, welcome, welcomeEnabled }); await onCreated(result.id); setName(''); setDescription(''); setWelcome(''); setNotificationMode('mentions'); setWelcomeEnabled(true); onClose(); }
        catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
      }}>
        <label>Name<input value={name} onChange={e => setName(e.target.value)} required maxLength={60} disabled={busy} /></label>
        <label>Description<input value={description} onChange={e => setDescription(e.target.value)} maxLength={200} disabled={busy} /></label>
        <label>Default notifications<select value={notificationMode} onChange={event => setNotificationMode(event.target.value)} disabled={busy}><option value='mentions'>Mentions only</option><option value='all'>All messages</option><option value='nothing'>Nothing</option><option value='inherit'>Use member preferences</option></select></label>
        <label className='check-label'><input type='checkbox' checked={welcomeEnabled} onChange={event => setWelcomeEnabled(event.target.checked)} disabled={busy}/>Show a welcome screen to new members</label>
        {welcomeEnabled && <label>Welcome message<textarea value={welcome} onChange={event => setWelcome(event.target.value)} maxLength={2000} disabled={busy}/></label>}
        <p className="login-help">This creates a private Matrix Space. Add encrypted {terms.channels} afterward. Each conversation keeps its own membership; inviting someone to the {terms.server} does not grant access to every conversation.</p>
        {error && <p className="connect-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy || !name.trim()}>{busy ? 'Creating…' : `Create ${terms.server}`}</button>
      </form>
    </DialogContent>
  </Dialog>;
}
