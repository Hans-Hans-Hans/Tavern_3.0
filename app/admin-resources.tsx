import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner, requestApi } from '@/lib/api';
import { Field } from './auth-gateway';
import { toast } from 'sonner';
export { AdminRooms } from './admin-room-browser';
const MiB = 1048576;
type StorageLimits = {
  maxUploadBytes: number; maxUploadAllowedBytes?: number; homeserverMaxUploadBytes?: number | null;
  userQuotaBytes: number; globalQuotaBytes: number; usageInitialized: boolean;
  globalUsedBytes: number | null; uncertainReservations: number; reconciledAt: number | null; scope?: string;
};
export function StoragePolicy() {
  const [value, setValue] = useState<StorageLimits | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [operation, setOperation] = useState('');
  const owner = accountArtworkOwner(), request = useRef(0);
  async function run(kind: 'load' | 'save' | 'reconcile') {
    const generation = ++request.current, current = () => generation === request.current && owner === accountArtworkOwner();
    setBusy(true); setOperation(kind); setError('');
    try {
      const result = await requestApi<StorageLimits>(kind === 'reconcile' ? '/admin/storage/reconcile' : '/admin/storage',
        kind === 'save' && value ? { maxUploadBytes: value.maxUploadBytes, userQuotaBytes: value.userQuotaBytes, globalQuotaBytes: value.globalQuotaBytes } : kind === 'reconcile' ? {} : undefined,
        kind === 'save' ? 'PUT' : kind === 'reconcile' ? 'POST' : 'GET');
      if (!current()) return;
      setValue(previous => kind === 'reconcile' ? { ...result, homeserverMaxUploadBytes: previous?.homeserverMaxUploadBytes } : result);
      if (kind !== 'load') toast.success(kind === 'save' ? 'Storage limits saved' : 'Storage usage checked against the homeserver');
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) { setBusy(false); setOperation(''); } }
  }
  useEffect(() => { setValue(null); void run('load'); return () => { request.current++; }; }, [owner]);
  const knownUsage = value?.usageInitialized === true && typeof value?.globalUsedBytes === 'number' && Number.isFinite(value.globalUsedBytes);
  const ceiling = (value?.maxUploadAllowedBytes || 10 * MiB) / MiB;
  return <section className="product-section">
    <div className="admin-toolbar"><h2>Storage limits and usage</h2><button className="secondary-button" disabled={busy} onClick={() => void run('load')}>Reload storage</button></div>
    <p>Choose how large one attachment can be and how much uploaded storage each account can use. Existing files are kept when you lower a limit.</p>
    {error && <p className="connect-error" role="alert">{error}</p>}
    {busy && !value && <p role="status">Checking storage…</p>}
    {value && <>
      <form className="dialog-form" onSubmit={event => { event.preventDefault(); void run('save'); }}>
        <fieldset disabled={busy}><legend>File uploads</legend>
          <Field label="Maximum file size (MiB)"><input type="number" required min={0.001} step={0.001} max={ceiling} value={value.maxUploadBytes / MiB} onChange={event => setValue({ ...value, maxUploadBytes: Math.round(Number(event.target.value) * MiB) })}/></Field>
          <div className="product-actions" aria-label="File size presets">{[10, 25, 50, 100, 250, 512].filter(size => size <= ceiling).map(size => <button type="button" className="secondary-button" key={size} aria-pressed={value.maxUploadBytes === size * MiB} onClick={() => setValue({ ...value, maxUploadBytes: size * MiB })}>{size} MiB</button>)}</div>
          <p className="login-help">Applies to each new attachment. You can choose up to {ceiling} MiB. Saved changes apply to new uploads without signing users out.</p>
          {typeof value.homeserverMaxUploadBytes === 'number' && <p>Running homeserver ceiling: {(value.homeserverMaxUploadBytes / MiB).toLocaleString()} MiB.</p>}
          {typeof value.homeserverMaxUploadBytes === 'number' && value.maxUploadBytes > value.homeserverMaxUploadBytes && <p role="status">This setting exceeds the running homeserver limit. Update the initializer and restart Synapse, or adjust a custom Synapse upload limit, before sending files this large.</p>}
          <p className="login-help">Your reverse proxy can impose a lower limit. If Cloudflare rejects an upload with 413, check its maximum upload size and your NPM settings.</p>
          <h3>Total storage</h3>
          {([['userQuotaBytes', 'Per-user quota (MiB)'], ['globalQuotaBytes', 'Instance quota (MiB)']] as const).map(([key, label]) => <Field label={label} key={key}><input type="number" required min={0.001} step={0.001} value={value[key] / MiB} onChange={event => setValue({ ...value, [key]: Math.round(Number(event.target.value) * MiB) })}/></Field>)}
          <p className="login-help">These quotas cover all uploaded files together. The file size limit must fit the per-user quota, and the per-user quota must fit the instance quota.</p>
          <button className="primary-button">{operation === 'save' ? 'Saving…' : 'Save storage policy'}</button>
        </fieldset>
      </form>
      <h3>Storage usage</h3><div className="admin-metrics"><article className="admin-metric"><span>Recorded instance usage</span><strong>{knownUsage ? (value.globalUsedBytes! / MiB).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' MiB' : 'Unavailable'}</strong></article><article className="admin-metric"><span>Uncertain upload reservations</span><strong>{Number.isSafeInteger(value.uncertainReservations) ? value.uncertainReservations : 'Unavailable'}</strong></article></div>
      <p>{value.scope || 'Storage scope is unavailable. Reload storage before relying on the usage count.'}</p>
      <p>Last reconciled: {typeof value.reconciledAt === 'number' && Number.isFinite(value.reconciledAt) ? new Date(value.reconciledAt).toLocaleString() : 'Not yet reconciled'}</p>
      {!knownUsage && <p role="status">Usage has not been verified. Uploads stay locked until the homeserver inventory can be checked.</p>}
      {value.uncertainReservations > 0 && <p>Some uploads lost their final response. Their reserved bytes remain counted until reconciliation confirms whether the files were stored.</p>}
      <button className="secondary-button" disabled={busy} onClick={() => void run('reconcile')}>{operation === 'reconcile' ? 'Reconciling usage…' : 'Reconcile storage usage'}</button>
      <p className="login-help">Reconciliation checks the homeserver's current media inventory and briefly pauses new uploads while updating the counts. Encrypted file contents are not inspected.</p>
    </>}
  </section>;
}
