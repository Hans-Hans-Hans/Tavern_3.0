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
  useEffect(() => {
    let active = true, pending = false, again = false;
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
  const protectedHistory = status?.identity && status.verified && status.backupVersion && status.canRestoreBackup;
  const needsAttention = !protectedHistory || history.error || history.local?.skipped || history.local?.limited;
  return <>
    {needsAttention && <aside className='history-recovery-banner' aria-label='Encrypted history recovery'>
      <div><strong>{history.busy ? 'Checking saved history keys…' : status?.serverBackupVersion ? 'Unlock your encrypted history' : 'Protect your encrypted history'}</strong>
        <p>{error || history.error || (history.busy ? 'Looking for keys from earlier sign-ins in this browser.' : history.local?.keys ? `Recovered ${history.local.keys} saved message keys in this browser. Set up or unlock recovery to keep history available on other devices.` : status?.serverBackupVersion ? 'Use your recovery key or verify this device to restore older messages.' : 'Save a recovery key so older messages remain available after signing in again or using another device.')}</p>
      </div><button className='secondary-button' onClick={() => setOpen(true)}>History recovery</button>
    </aside>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className='tavern-dialog settings-dialog'><DialogHeader><DialogTitle>Recover and protect your messages</DialogTitle><DialogDescription>Message history is encrypted. Your account password alone cannot unlock keys from other devices.</DialogDescription></DialogHeader>
      <SecurityCenter/><DeviceManager/>
    </DialogContent></Dialog>
  </>;
}
