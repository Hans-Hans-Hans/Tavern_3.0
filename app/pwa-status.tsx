import { useEffect, useState, useSyncExternalStore } from 'react';
import { Download, RefreshCw, WifiOff, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { applyAppUpdate, initializePwa, installTavern, pwaSnapshot, reconnectTavern, subscribePwa } from '@/lib/pwa';
import './pwa.css';

export function InstallTavern() {
  const state = useSyncExternalStore(subscribePwa, pwaSnapshot), [instructions, setInstructions] = useState(false), [busy, setBusy] = useState(false);
  useEffect(initializePwa, []);
  if (state.installed) return <p className="pwa-installed">Tavern is installed on this device.</p>;
  return <><button className="secondary-button" disabled={busy} onClick={() => { setBusy(true); void installTavern().then(shown => { if (!shown) setInstructions(true); }).catch(() => setInstructions(true)).finally(() => setBusy(false)); }}><Download size={16}/>Install Tavern</button><Dialog open={instructions} onOpenChange={setInstructions}><DialogContent><DialogHeader><DialogTitle>Install Tavern</DialogTitle><DialogDescription>Keep Tavern in its own app window and open it from your home screen.</DialogDescription></DialogHeader><p>In Chrome or Edge, use the browser menu and choose “Install Tavern” or “Install page as app”. On iPhone or iPad, open Tavern in Safari, tap Share, then “Add to Home Screen”.</p><p>Other browsers can save a shortcut or bookmark. Installation uses the same account and browser storage on this device.</p></DialogContent></Dialog></>;
}

export function PwaStatus() {
  const state = useSyncExternalStore(subscribePwa, pwaSnapshot), [hidden, setHidden] = useState(false), [busy, setBusy] = useState(false);
  useEffect(initializePwa, []);
  useEffect(() => setHidden(false), [state.online, state.updateAvailable, state.message]);
  if (state.applying) return <div className="pwa-updating" role="alertdialog" aria-modal="true" aria-label="Applying Tavern update"><RefreshCw className="spin"/><strong>Preparing the app update</strong><p>Checking that every Tavern window can safely reload…</p></div>;
  if (hidden || (state.online && !state.updateAvailable && !state.message)) return null;
  return <aside className="pwa-status" role="status"><div>{!state.online ? <WifiOff/> : <RefreshCw/>}<div><strong>{!state.online ? 'You’re offline' : state.updateAvailable ? 'An app update is ready' : 'App storage'}</strong><p>{state.message || (!state.online ? 'Your connection is unavailable. Loaded conversations stay open; sending resumes when connected.' : 'Sign out in all Tavern windows before reloading to keep encryption and calls safe.')}</p></div></div><div className="pwa-actions">{!state.online ? <button className="secondary-button" disabled={busy} onClick={() => { setBusy(true); void reconnectTavern().finally(() => setBusy(false)); }}>Try reconnecting</button> : state.updateAvailable && <button className="secondary-button" onClick={() => void applyAppUpdate()}>Apply update</button>}<button className="icon-button" aria-label="Dismiss app status" onClick={() => setHidden(true)}><X size={18}/></button></div></aside>;
}
