import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ManagementSections } from '../../../app/management-sections';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../components/ui/dialog';
import '../../../app/globals.css';
import '../../../app/product.css';

const definitions = [
  ['general', 'General'], ['roles', 'Roles and member permissions'], ['invitations', 'Invitations and access'],
  ['moderation', 'Moderation and safety'], ['customization', 'Customization and system notices'],
];
function Editor({ id, scope }: { id: string; scope: string }) {
  const [draft, setDraft] = useState('');
  useEffect(() => {
    const f = (window as any).managementFixture; f.mounted.push(scope + '/' + id);
    return () => { f.unmounted.push(scope + '/' + id); };
  }, [id, scope]);
  return <section aria-label={id + ' editor'}><label>{id} draft<input aria-label={id + ' draft'} value={draft} onChange={event => setDraft(event.target.value)}/></label><button type='button'>Save {id}</button></section>;
}
export function mountFixture() {
  const f = (window as any).managementFixture = { mounted: [] as string[], unmounted: [] as string[] };
  const root = createRoot(document.getElementById('root')!);
  f.render = (scope = 'server-a', omitted = '') => root.render(<Dialog open><DialogContent className='tavern-dialog' style={{ width: 'calc(100% - 2rem)', maxWidth: 880 }}>
    <DialogHeader><DialogTitle>Manage {scope}</DialogTitle><DialogDescription>Choose a section to manage this server.</DialogDescription></DialogHeader>
    <ManagementSections key={scope} label='Server management sections' sections={definitions.filter(([id]) => id !== omitted).map(([id, title]) => ({ id, title, content: <Editor id={id} scope={scope}/> }))}/>
  </DialogContent></Dialog>);
  f.render();
}
