import { useEffect, useState } from 'react';
import { requestDeviceVerification, subscribeSecurity } from '@/lib/security';
import { getMatrixClient, revokeMatrixDevice } from '@/lib/matrix';

type Device = { device_id: string; display_name?: string; last_seen_ts?: number };
export function DeviceManager() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState<Device | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fingerprint,setFingerprint]=useState('');
  const client = getMatrixClient();
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  useEffect(() => { let active=true; const refresh=async()=>{if(!client?.getCrypto())return; const entries=await Promise.all(devices.map(async d=>[d.device_id,(await client.getCrypto()!.getDeviceVerificationStatus(client.getUserId()!,d.device_id))?.isVerified()??false] as const));if(active)setVerified(Object.fromEntries(entries));};void refresh().catch(()=>{});const off=subscribeSecurity(()=>void refresh().catch(()=>{}));return()=>{active=false;off();};},[client,devices]);
  useEffect(() => {
    let active = true;
    if (!client) { setLoading(false); return; }
    void client.getCrypto()?.getOwnDeviceKeys().then(keys=>{if(active)setFingerprint(keys.ed25519);}).catch(()=>{});
    client.getDevices().then(r => { if (active) setDevices(r.devices); })
      .catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client]);
  return <section className="session-manager"><h3>Signed-in devices</h3>
    <p className="login-help">Review sessions on your homeserver. Removing a session revokes its access; it cannot erase files or messages already downloaded. Compare emoji on another device to verify its encryption identity.</p>
    {fingerprint && <details><summary>This device’s public fingerprint</summary><p className="login-help">Use this Ed25519 key when explicitly approving this device for an integration. Compare it on this device through a trusted channel.</p><code style={{overflowWrap:"anywhere"}}>{fingerprint}</code></details>}
    {loading && <p>Loading sessions…</p>}
    {!client && <p>Sign in to manage your sessions.</p>}
    {devices.map(device => <div className="device-row" key={device.device_id}>
      <span><strong>{device.display_name || device.device_id}</strong><small>{verified[device.device_id] ? 'Verified' : 'Unverified'} · {device.device_id} · {device.last_seen_ts ? new Date(device.last_seen_ts).toLocaleString() : 'Last seen unavailable'}</small></span>
      {device.device_id === client?.getDeviceId() ? <small>This device</small> : <div className="inline-actions"><button className="secondary-button" disabled={busy} onClick={() => { setBusy(true); requestDeviceVerification(device.device_id).catch(e=>setError(e.message)).finally(()=>setBusy(false)); }}>Verify</button><button className="secondary-button" disabled={busy} onClick={() => { setSelected(device); setError(''); setPassword(''); }}>Revoke</button></div>}
    </div>)}
    {selected && <form className="dialog-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { await revokeMatrixDevice(selected.device_id, password); setDevices(d => d.filter(x => x.device_id !== selected.device_id)); setSelected(null); }
      catch (error) { setError((error as Error).message); }
      finally { setBusy(false); setPassword(''); }
    }}>
      <p>Revoke <strong>{selected.display_name || selected.device_id}</strong>? That session will need to sign in again. Export any keys you still need from that device first.</p>
      <label>Account password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required disabled={busy} /></label>
      <div className="inline-actions"><button className="primary-button" disabled={busy}>Confirm revocation</button><button type="button" className="secondary-button" disabled={busy} onClick={() => { setSelected(null); setPassword(''); }}>Cancel</button></div>
    </form>}
    {error && <p className="connect-error" role="alert">{error}</p>}
  </section>;
}
