import { EmailHistoryRecovery } from './email-history-recovery';
import { useEffect, useState } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { historyRecoverySnapshot, securityStatus, subscribeSecurity } from '@/lib/security';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SecurityCenter } from './security-center';
import { DeviceManager } from './device-manager';
import './history-recovery.css';

export function HistoryRecovery() {
  const [client, setClient] = useState(getMatrixClient);
  useEffect(() => onMatrixUpdate(() => setClient(getMatrixClient())), []);
  return client ? <ConnectedHistoryRecovery key={`${client.getUserId()}:${client.getDeviceId()}`} client={client}/> : null;
}
function ConnectedHistoryRecovery({ client }: { client: MatrixClient }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof securityStatus>> | null>(null);
  const [history, setHistory] = useState(historyRecoverySnapshot), [error, setError] = useState(''), [open, setOpen] = useState(false);
  const [emailConfigured,setEmailConfigured]=useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const reminderKey = 'tavern.history-reminder.v1:' + JSON.stringify([client.getHomeserverUrl(), client.getUserId()]);
  const reminderVersion = status ? JSON.stringify([status.serverBackupVersion, status.recoveryConfigured]) : null;
  useEffect(() => {
    let active = true, pending = false, again = false;
    setStatus(null); setError(''); setOpen(false); setDismissed(null);setEmailConfigured(false);
    const refresh = async () => {
      if (pending) { again = true; return; }
      pending = true;
      do {
        again = false;
        if (!active || getMatrixClient() !== client) break;
        setHistory(historyRecoverySnapshot());
        try { const value = await securityStatus(); if (active && getMatrixClient() === client) { setStatus(value); setError(''); } }
        catch { if (active && getMatrixClient() === client) setError('Recovery status is unavailable. Open history recovery to retry.'); }
      } while (again && active);
      pending = false;
    };
    void refresh(); const off = subscribeSecurity(() => { setHistory(historyRecoverySnapshot()); void refresh(); });
    return () => { active = false; off(); };
  }, [client]);
  useEffect(() => {
    try { setDismissed(localStorage.getItem(reminderKey)); } catch { /* Reminders still work without browser storage. */ }
  }, [reminderKey, client]);
  // Signing-key availability is separate from possession of the matching
  // history-backup key. Do not ask users to recover an already readable backup,
  // or flash a warning while the automatic local recovery is still running.
  const needsAttention = !emailConfigured && !!status && history.checked && !history.busy && !status.canRestoreBackup && dismissed !== reminderVersion;
  const remindLater = () => {
    if (getMatrixClient() !== client || !reminderVersion) return;
    setDismissed(reminderVersion);
    try { localStorage.setItem(reminderKey, reminderVersion); } catch { /* Dismiss for this mounted view. */ }
  };
  return <>
    <EmailHistoryRecovery automatic onConfigured={setEmailConfigured} backupVersion={status?.serverBackupVersion} known={status?.canRestoreBackup===true} ready={!!status&&history.checked&&!history.busy}/>
    {needsAttention && <aside className='history-recovery-banner' aria-label='Encrypted history recovery'>
      <div><strong>{history.local?.keys ? 'Keep history available on your other devices' : status?.serverBackupVersion ? 'Older messages may need recovery' : 'Keep a backup of your messages'}</strong>
        <p>{error || history.error || (history.local?.keys ? `Recovered ${history.local.keys} saved message keys in this browser.` : status?.serverBackupVersion ? 'Use your recovery key or verify this device if older messages are locked.' : 'Set up a recovery key once to protect history when you change devices.')} You can continue messaging. Recovery is always available in Settings → Privacy.</p>
      </div><div className='history-recovery-actions'><button className='secondary-button' onClick={() => setOpen(true)}>History recovery</button><button className='text-button' onClick={remindLater}>Dismiss reminder</button></div>
    </aside>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className='tavern-dialog settings-dialog'><DialogHeader><DialogTitle>Recover and protect your messages</DialogTitle><DialogDescription>Message history is encrypted. Known browsers use saved keys. New devices can unlock a password-protected history package with an email code after recovery is enabled.</DialogDescription></DialogHeader>
      <SecurityCenter/><DeviceManager/>
    </DialogContent></Dialog>
  </>;
}
