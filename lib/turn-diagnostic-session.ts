import type { MatrixClient } from 'matrix-js-sdk';
import type { Logger } from 'matrix-js-sdk/lib/logger';
import type { AccountSession } from './api';
import { TurnDiagnosticUnavailable, turnDiagnosticTimeout } from './turn-diagnostics';

// The SDK normally logs credential endpoints and transport errors. This
// request-only client emits no raw diagnostic logs, even on failed requests.
const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild() { return silent; } };

export async function verifyDiagnosticAdmin(session: AccountSession, current: () => boolean, signal: AbortSignal) {
  const check = () => { if (signal.aborted || !current()) throw new TurnDiagnosticUnavailable('unauthorized'); };
  check();
  if (!session.admin || !session.deviceId || !session.userId) throw new TurnDiagnosticUnavailable('unauthorized');
  const base = new URL(session.baseUrl, location.origin);
  if (base.origin !== location.origin || base.pathname.replace(/\/$/, '') !== '/api/matrix' || base.username || base.password || base.search || base.hash) throw new TurnDiagnosticUnavailable('unauthorized');
  const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    headers: { Accept: 'application/json', 'X-Tavern-Device': session.deviceId } });
  check();
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new TurnDiagnosticUnavailable('unauthorized'); }
  const fresh = await response.json(); check();
  if (fresh?.admin !== true || fresh.userId !== session.userId || fresh.deviceId !== session.deviceId
    || fresh.passwordChangeRequired !== false || fresh.mfaEnrollmentRequired !== false || new URL(fresh.baseUrl, location.origin).href !== base.href) throw new TurnDiagnosticUnavailable('unauthorized');
  return base;
}

export async function prepareDiagnosticTurn(session: AccountSession, existing: MatrixClient | null,
  current: () => boolean, signal: AbortSignal) {
  const check = () => { if (signal.aborted || !current()) throw new TurnDiagnosticUnavailable('unauthorized'); };
  const base = await verifyDiagnosticAdmin(session, current, signal); check();
  let client = existing, owned = false;
  try {
    if (!client) {
      const { createClient } = await import('matrix-js-sdk'); check();
      client = createClient({ baseUrl: base.href, userId: session.userId, deviceId: session.deviceId, accessToken: 'cookie-session:' + session.deviceId,
        logger: silent, forceTURN: true, fallbackICEServerAllowed: false,
        fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
          check(); const target = new URL(String(url), location.origin);
          if (target.origin !== base.origin || target.pathname !== '/api/matrix/_matrix/client/v3/voip/turnServer' || target.search || target.hash) throw new TurnDiagnosticUnavailable('unauthorized');
          const headers = new Headers(init?.headers); headers.set('X-Tavern-Device', session.deviceId);
          const result = await fetch(target, { ...init, headers, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
          if (signal.aborted || !current()) { await result.body?.cancel().catch(() => {}); check(); }
          return result;
        }) as typeof fetch });
      owned = true;
    }
    const matchingClient = () => client?.getUserId() === session.userId && client.getDeviceId() === session.deviceId
      && new URL(client.getHomeserverUrl(), location.origin).href.replace(/\/$/, '') === base.href.replace(/\/$/, '');
    if (!matchingClient()) throw new TurnDiagnosticUnavailable('unauthorized');
    const ready = await client.checkTurnServers(); check();
    if (!matchingClient()) throw new TurnDiagnosticUnavailable('unauthorized');
    const expiry = client.getTurnServersExpiry();
    if (!ready || !Number.isFinite(expiry) || expiry < Date.now() + turnDiagnosticTimeout) throw new TurnDiagnosticUnavailable('not-configured');
    return client.getTurnServers();
  } finally { if (owned) client?.stopClient(); }
}
