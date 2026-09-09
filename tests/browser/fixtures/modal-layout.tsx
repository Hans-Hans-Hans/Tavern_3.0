import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from '../../../components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel, AlertDialogTrigger } from '../../../components/ui/alert-dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs';
import { Switch } from '../../../components/ui/switch';
import { AppearanceSettings } from '../../../app/appearance-settings';
import '../../../app/globals.css';
import '../../../app/product.css';

const sections = ['Appearance', 'Profile', 'Friends & privacy', 'Account & security', 'Notifications', 'Text & media', 'Outbox & reminders', 'Privacy', 'Tavern', 'About'];
function Fixture() {
  const [accent, setAccent] = useState('gold'), [compact, setCompact] = useState(false), [confirmed, setConfirmed] = useState(false);
  return <main style={{ padding: 20 }}>
    <Dialog><DialogTrigger>Open settings</DialogTrigger><DialogContent className='tavern-dialog settings-dialog'>
      <DialogHeader><DialogTitle>Tavern settings</DialogTitle><DialogDescription>Manage your preferences and account.</DialogDescription></DialogHeader>
      <Tabs defaultValue='Appearance' className='settings-tabs'><TabsList aria-label='Settings sections'>{sections.map(name => <TabsTrigger key={name} value={name}>{name}</TabsTrigger>)}</TabsList>
        <TabsContent value='Appearance'><div className='settings-section'>
          <div className='setting-row'><span><strong>Legacy naming</strong><small>Use Taverns and Guilds. The default is servers and channels.</small></span><Switch aria-label='Use legacy naming'/></div>
          <AppearanceSettings/>
          <div className='setting-row'><span><strong>Focus mode</strong><small>Hide unread counts, typing activity, and the details panel.</small></span><Switch aria-label='Focus mode'/></div>
          <h3>Your accent</h3><div className='accent-options'>{['gold', 'blue', 'violet'].map(value => <button key={value} className={value + (accent === value ? ' chosen' : '')} aria-pressed={accent === value} onClick={() => setAccent(value)}><span/>{value === 'gold' ? 'Tavern gold' : value === 'blue' ? 'Slate blue' : 'Dusk violet'}</button>)}</div>
          <div className='setting-row'><span><strong>Compact messages</strong><small>A little less space between conversations.</small></span><Switch aria-label='Compact messages' checked={compact} onCheckedChange={setCompact}/></div>
        </div></TabsContent>
        {sections.slice(1).map(name => <TabsContent value={name} key={name}><p>{name} preferences</p></TabsContent>)}
      </Tabs>
    </DialogContent></Dialog>
    <AlertDialog><AlertDialogTrigger>Open confirmation</AlertDialogTrigger><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Confirm changes for {'A'.repeat(90)}</AlertDialogTitle><AlertDialogDescription>The selected account is {'@long-account-name:'.repeat(14)}. Review the entire confirmation before continuing.</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Keep my current configuration</AlertDialogCancel><AlertDialogAction onClick={() => setConfirmed(true)}>Confirm these configuration changes</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
    {confirmed && <p role='status'>Configuration confirmed.</p>}
  </main>;
}
export function mountFixture() { createRoot(document.getElementById('root')!).render(<Fixture/>); }
