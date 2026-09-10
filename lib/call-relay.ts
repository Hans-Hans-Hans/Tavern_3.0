import type { MatrixClient } from 'matrix-js-sdk';
import { checkedTurnServers } from './turn-diagnostics';

export const callRelayError = 'The TURN service could not provide fresh relay credentials. Try again or ask your administrator to check TURN.';
export const callCancelledError = 'The call was canceled.';
export function currentCallRelay(client: MatrixClient): RTCIceServer[] {
  const expiry = client.getTurnServersExpiry();
  if (!Number.isFinite(expiry) || expiry < Date.now() + 15000) throw new Error(callRelayError);
  try { return checkedTurnServers(client.getTurnServers()); }
  catch { throw new Error(callRelayError); }
}
export async function refreshCallRelay(client: MatrixClient, current: () => boolean): Promise<RTCIceServer[]> {
  if (!current()) throw new Error(callCancelledError);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let refreshed: boolean | undefined;
    try { refreshed = await Promise.race([client.checkTurnServers(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(callRelayError)), 15000); })]); }
    catch { if (!current()) throw new Error(callCancelledError); throw new Error(callRelayError); }
    if (!current()) throw new Error(callCancelledError);
    if (refreshed !== true) throw new Error(callRelayError);
    return currentCallRelay(client);
  } finally { clearTimeout(timer); }
}
/** Only before the first local description. Never restart or reroute an
 * established call, and never modify the SDK's private TURN snapshot. */
export function configureInitialCallRelay(peer: RTCPeerConnection, servers: RTCIceServer[], current: () => boolean) {
  if (!current()) throw new Error(callCancelledError);
  if (peer.localDescription || !['stable', 'have-remote-offer'].includes(peer.signalingState) ||
      ['connected', 'disconnected', 'failed', 'closed'].includes(peer.connectionState)) throw new Error(callCancelledError);
  try { peer.setConfiguration({ ...peer.getConfiguration(), iceServers: servers, iceTransportPolicy: 'relay' }); }
  catch { throw new Error(callRelayError); }
}
