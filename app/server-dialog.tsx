import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { matrixApi } from '@/lib/matrix';
import { terminology, type Naming } from '@/lib/terminology';

export function ServerDialog({ open, naming, onClose, onCreated }: {
  open: boolean; naming: Naming; onClose: () => void; onCreated: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const terms = terminology(naming);
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <DialogContent className="tavern-dialog">
      <DialogHeader><DialogTitle>Create a {terms.server}</DialogTitle>
        <DialogDescription>Organize your conversations around a team, project, or community.</DialogDescription></DialogHeader>
      <form className="dialog-form" onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError('');
        try { const result = await matrixApi('createServer', { name, description }); await onCreated(result.id); setName(''); setDescription(''); onClose(); }
        catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
      }}>
        <label>Name<input value={name} onChange={e => setName(e.target.value)} required maxLength={60} disabled={busy} /></label>
        <label>Description<input value={description} onChange={e => setDescription(e.target.value)} maxLength={200} disabled={busy} /></label>
        <p className="login-help">This creates a private Matrix Space. Add encrypted {terms.channels} afterward. Each conversation keeps its own membership; inviting someone to the {terms.server} does not grant access to every conversation.</p>
        {error && <p className="connect-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy || !name.trim()}>{busy ? 'Creating…' : `Create ${terms.server}`}</button>
      </form>
    </DialogContent>
  </Dialog>;
}
