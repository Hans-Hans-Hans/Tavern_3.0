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

type StorageInventory = { measuredAt: number; totalUploadedBytes: number; scope: string; mounted: { label: string; bytes: number; files: number; entries: { name: string; bytes: number; files: number }[] }[]; uploaders: { userId: string; bytes: number }[] };
type MediaInventory = { userId: string; inventoryId: string; total: number | null; next: string | number | null; items: { id: string; bytes: number; name?: string; type?: string; createdAt?: number }[] };
const displayBytes = (value: number) => value < 1024 ? value + ' B' : value < MiB ? (value / 1024).toFixed(1) + ' KiB' : value < MiB * 1024 ? (value / MiB).toFixed(2) + ' MiB' : (value / (MiB * 1024)).toFixed(2) + ' GiB';

export function StorageDiagnostics() {
  const [summary, setSummary] = useState<StorageInventory | null>(null), [media, setMedia] = useState<MediaInventory | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmation, setConfirmation] = useState<{ userId: string; mediaId: string } | null>(null), [typed, setTyped] = useState('');
  const owner = accountArtworkOwner(), request = useRef(0);
  const current = (generation: number) => generation === request.current && owner === accountArtworkOwner();
  async function load() {
    const generation = ++request.current; setBusy(true); setError('');
    try { const value = await requestApi<StorageInventory>('/admin/storage/inventory'); if (current(generation)) setSummary(value); }
    catch (failure) { if (current(generation)) setError((failure as Error).message); }
    finally { if (current(generation)) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { request.current++; }; }, [owner]);
  async function inspect(userId: string, from?: string | number) {
    const generation = ++request.current; setBusy(true); setError(''); setConfirmation(null); setTyped('');
    try { const value = await requestApi<MediaInventory>('/admin/storage/users/' + encodeURIComponent(userId) + '/media' + (from == null ? '' : '?from=' + encodeURIComponent(String(from)))); if (current(generation)) setMedia(value); }
    catch (failure) { if (current(generation)) setError((failure as Error).message); }
    finally { if (current(generation)) setBusy(false); }
  }
  async function remove() {
    if (!confirmation || typed !== 'DELETE ' + confirmation.mediaId) return;
    const generation = ++request.current; setBusy(true); setError('');
    try {
      if (!media || media.userId !== confirmation.userId) return;
      const result = await requestApi<{ usageRefreshed: boolean }>('/admin/storage/media', { userId: confirmation.userId, mediaId: confirmation.mediaId, confirmation: typed, inventoryId: media.inventoryId }, 'DELETE');
      if (!current(generation)) return;
      toast.success(result.usageRefreshed ? 'Media deleted and storage usage refreshed' : 'Media deleted; reload storage usage to refresh totals');
      setConfirmation(null); setTyped('');
      await Promise.all([load(), inspect(confirmation.userId)]);
    } catch (failure) { if (current(generation)) setError((failure as Error).message); }
    finally { if (current(generation)) setBusy(false); }
  }
  return <section className="product-section" aria-label="Storage diagnostics">
    <div className="admin-toolbar"><h2>Storage diagnostics</h2><button className="secondary-button" disabled={busy} onClick={() => void load()}>Measure storage</button></div>
    <p>Find the largest Tavern-owned data areas and local uploads. Media deletion removes the original local file and its generated thumbnails. It cannot be undone or remove copies already downloaded by members.</p>
    {error && <p className="connect-error" role="alert">{error}</p>}
    {busy && !summary && <p role="status">Measuring storage…</p>}
    {summary && <>
      <div className="admin-metrics"><article className="admin-metric"><span>Local original uploads</span><strong>{displayBytes(summary.totalUploadedBytes)}</strong></article><article className="admin-metric"><span>Measured at</span><strong>{new Date(summary.measuredAt).toLocaleTimeString()}</strong></article></div>
      <div className="admin-resource-scroll"><table className="admin-resource-table"><thead><tr><th>Mounted area</th><th>Used</th><th>Files</th></tr></thead><tbody>{summary.mounted.map(root => <tr key={root.label}><th>{root.label}</th><td>{displayBytes(root.bytes)}</td><td>{root.files.toLocaleString()}</td></tr>)}</tbody></table></div>
      {summary.mounted.map(root => <details key={root.label}><summary>{root.label} breakdown</summary><div className="admin-resource-scroll"><table className="admin-resource-table"><thead><tr><th>Item</th><th>Used</th><th>Files</th></tr></thead><tbody>{root.entries.map(entry => <tr key={entry.name}><th>{entry.name}</th><td>{displayBytes(entry.bytes)}</td><td>{entry.files.toLocaleString()}</td></tr>)}</tbody></table></div></details>)}
      <h3>Largest local uploaders</h3>
      {!summary.uploaders.length ? <p>No local original media was reported by Synapse.</p> : <div className="admin-resource-scroll"><table className="admin-resource-table"><thead><tr><th>Account</th><th>Original uploads</th><th></th></tr></thead><tbody>{summary.uploaders.map(item => <tr key={item.userId}><th>{item.userId}</th><td>{displayBytes(item.bytes)}</td><td><button className="secondary-button" disabled={busy} onClick={() => void inspect(item.userId)}>Review uploads</button></td></tr>)}</tbody></table></div>}
      <p className="login-help">{summary.scope}</p>
    </>}
    {media && <section className="storage-media-inventory"><div className="admin-toolbar"><h3>Uploads from {media.userId}</h3><button className="secondary-button" disabled={busy} onClick={() => setMedia(null)}>Close</button></div><p>{media.total == null ? 'Showing a page of uploads.' : 'Showing uploads from ' + media.total.toLocaleString() + ' recorded item' + (media.total === 1 ? '.' : 's.')}</p><div className="admin-resource-scroll"><table className="admin-resource-table"><thead><tr><th>File</th><th>Type</th><th>Size</th><th>Created</th><th></th></tr></thead><tbody>{media.items.map(item => <tr key={item.id}><th title={item.id}>{item.name || item.id}</th><td>{item.type || 'Unknown'}</td><td>{displayBytes(item.bytes)}</td><td>{typeof item.createdAt === 'number' ? new Date(item.createdAt).toLocaleString() : 'Unknown'}</td><td><button className="secondary-button" disabled={busy} onClick={() => { setConfirmation({ userId: media.userId, mediaId: item.id }); setTyped(''); }}>Delete</button></td></tr>)}</tbody></table></div>{media.next != null && <button className="secondary-button" disabled={busy} onClick={() => void inspect(media.userId, media.next ?? undefined)}>Next uploads</button>}</section>}
    {confirmation && <section className="notice storage-delete-confirm" role="alert"><h3>Delete local media permanently?</h3><p>This removes <strong>{confirmation.mediaId}</strong> from Tavern’s homeserver. Messages that reference it will remain, but the file will no longer load.</p><Field label={'Type DELETE ' + confirmation.mediaId + ' to confirm'}><input value={typed} autoComplete="off" onChange={event => setTyped(event.target.value)} /></Field><div className="product-actions"><button className="primary-button" disabled={busy || typed !== 'DELETE ' + confirmation.mediaId} onClick={() => void remove()}>Delete permanently</button><button className="secondary-button" disabled={busy} onClick={() => { setConfirmation(null); setTyped(''); }}>Cancel</button></div></section>}
  </section>;
}
