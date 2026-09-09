import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner, isManagedAccount, type AccountSession } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { runTurnDiagnostic, type TurnDiagnosticResult } from '@/lib/turn-diagnostics';
import { prepareDiagnosticTurn, verifyDiagnosticAdmin } from '@/lib/turn-diagnostic-session';

const descriptions = {
  failed: 'No relay candidate was obtained. Check TURN DNS, credentials and firewall reachability, then retry.',
  timeout: 'The TURN test timed out after 15 seconds. Check TURN reachability from this network and retry.',
  cancelled: 'TURN test cancelled.',
  unavailable: 'TURN testing is unavailable in this browser or the server returned an unsupported configuration.',
  'not-configured': 'Current TURN credentials are unavailable. Enable calls and check the homeserver TURN configuration.',
  unauthorized: 'Current administrator access could not be verified. Reopen Admin Diagnostics after signing in.',
};

export function TurnDiagnostics({ session }: { session: AccountSession }) {
  const latest = useRef(session); latest.current = session;
  const [owner] = useState(() => { const client = getMatrixClient(); return { client, clientBase: client?.getHomeserverUrl(), account: accountArtworkOwner(), ...session }; });
  const alive = useRef(false), controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [result, setResult] = useState<TurnDiagnosticResult | null>(null);
  const current = () => alive.current && isManagedAccount() && owner.admin && latest.current.admin
    && latest.current.userId === owner.userId && latest.current.deviceId === owner.deviceId && latest.current.baseUrl === owner.baseUrl
    && accountArtworkOwner() === owner.account && getMatrixClient() === owner.client
    && (!owner.client || owner.client.getUserId() === owner.userId && owner.client.getDeviceId() === owner.deviceId && owner.client.getHomeserverUrl() === owner.clientBase);
  useEffect(() => {
    alive.current = true;
    const update = () => { if (!current()) { controller.current?.abort(); setResult(null); setBusy(false); setStale(true); } };
    const off = onMatrixUpdate(update), timer = setInterval(update, 250);
    window.addEventListener('tavern:signout', update); window.addEventListener('pagehide', stop);
    function stop() { controller.current?.abort(); }
    return () => { alive.current = false; controller.current?.abort(); off(); clearInterval(timer); window.removeEventListener('tavern:signout', update); window.removeEventListener('pagehide', stop); };
  }, [owner]);
  async function start() {
    if (!current() || controller.current) return;
    const attempt = new AbortController(); controller.current = attempt; setBusy(true); setResult(null);
    const value = await runTurnDiagnostic({ signal: attempt.signal, current, prepare: signal => prepareDiagnosticTurn(owner, owner.client, current, signal),
      verify: async signal => { await verifyDiagnosticAdmin(owner, current, signal); } });
    if (controller.current !== attempt) return;
    controller.current = null;
    if (!alive.current) return;
    setBusy(false);
    if (!current()) { setResult(null); setStale(true); } else setResult(value);
  }
  return <section className="product-section" aria-label="Browser TURN test"><h2>Browser TURN test</h2>
    <p>Test relay allocation from this browser and network using your account’s short-lived TURN credentials. No microphone or camera access is requested.</p>
    <p>A relay candidate confirms allocation only. It does not verify a complete call, media delivery or reachability from every network. Test a call from outside your LAN separately.</p>
    <div className="product-actions"><button className="secondary-button" disabled={busy || stale} onClick={() => void start()}>Test TURN allocation</button>
      {busy && <button className="secondary-button" onClick={() => controller.current?.abort()}>Cancel TURN test</button>}</div>
    {busy && <p role="status">Checking TURN allocation…</p>}
    {stale && <p role="status">Your account or administrator session changed. Reopen Diagnostics to run this test.</p>}
    {!stale && result && <p role="status">{result.status === 'allocated' ? <>Relay candidate obtained.{result.protocol && <> Relay candidate protocol: {result.protocol.toUpperCase()}.</>}</> : descriptions[result.status]}</p>}
  </section>;
}
