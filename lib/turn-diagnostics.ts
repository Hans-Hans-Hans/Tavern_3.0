/** A relay allocation proves only this browser's path to a TURN service. It
 * neither captures media nor establishes a peer connection to another user. */
export const turnDiagnosticTimeout = 15000;
export type TurnDiagnosticResult = { status: 'allocated'; protocol?: 'udp' | 'tcp' } | {
  status: 'failed' | 'timeout' | 'cancelled' | 'unavailable' | 'not-configured' | 'unauthorized';
};
export class TurnDiagnosticUnavailable extends Error {
  constructor(readonly status: 'unavailable' | 'not-configured' | 'unauthorized') { super(status); }
}
type Clock = { setTimeout: typeof globalThis.setTimeout; clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval; clearInterval: typeof globalThis.clearInterval };
type Options = { current: () => boolean; prepare: (signal: AbortSignal) => Promise<RTCIceServer[]>; verify?: (signal: AbortSignal) => Promise<void>; signal: AbortSignal;
  createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection; clock?: Clock };

export function checkedTurnServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value) || !value.length) throw new TurnDiagnosticUnavailable('not-configured');
  if (value.length > 4) throw new TurnDiagnosticUnavailable('unavailable');
  let count = 0;
  return value.map(server => {
    if (!server || typeof server !== 'object' || !Array.isArray(server.urls) || !server.urls.length
      || typeof server.username !== 'string' || !server.username || server.username.length > 1024
      || typeof server.credential !== 'string' || !server.credential || server.credential.length > 4096) throw new TurnDiagnosticUnavailable('unavailable');
    const urls = server.urls.map((url: unknown) => {
      if (typeof url !== 'string' || url.length > 2048 || ++count > 8
        || !/^turns?:(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?(?:\?transport=(?:udp|tcp))?$/i.test(url)) throw new TurnDiagnosticUnavailable('unavailable');
      // Validate IPv6 and port grammar using the platform URL parser. No HTTP
      // request is made and no user-controlled URL is ever displayed.
      try { const parsed = new URL('http://' + url.replace(/^turns?:/i, '').split('?')[0]); if (!parsed.hostname || parsed.port === '0') throw new Error(); }
      catch { throw new TurnDiagnosticUnavailable('unavailable'); }
      return url;
    });
    return { urls, username: server.username, credential: server.credential };
  });
}

export function runTurnDiagnostic(options: Options): Promise<TurnDiagnosticResult> {
  const clock = options.clock || globalThis, controller = new AbortController();
  return new Promise(resolve => {
    let done = false, verifying = false, peer: RTCPeerConnection | undefined, channel: RTCDataChannel | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
    const current = () => { try { return options.current(); } catch { return false; } };
    const finish = (result: TurnDiagnosticResult) => {
      if (done) return;
      done = true; controller.abort(); clock.clearTimeout(deadline); clock.clearInterval(poll);
      options.signal.removeEventListener('abort', cancel);
      if (peer) { peer.onicecandidate = null; peer.onicegatheringstatechange = null; peer.oniceconnectionstatechange = null; }
      try { channel?.close(); } catch { /* Already closed. */ }
      try { peer?.close(); } catch { /* Already closed. */ }
      resolve(current() ? result : { status: 'cancelled' });
    };
    const cancel = () => finish({ status: 'cancelled' });
    const active = () => { if (done) return false; if (!current() || options.signal.aborted) { cancel(); return false; } return true; };
    options.signal.addEventListener('abort', cancel, { once: true });
    if (!active()) return;
    deadline = clock.setTimeout(() => finish({ status: 'timeout' }), turnDiagnosticTimeout);
    poll = clock.setInterval(() => { active(); }, 250);
    void (async () => {
      if (!options.createPeer && typeof RTCPeerConnection === 'undefined') throw new TurnDiagnosticUnavailable('unavailable');
      const servers = checkedTurnServers(await options.prepare(controller.signal));
      if (!active()) return;
      peer = (options.createPeer || (configuration => new RTCPeerConnection(configuration)))({ iceServers: servers, iceTransportPolicy: 'relay', iceCandidatePoolSize: 0 });
      if (!active()) return;
      peer.onicecandidate = event => {
        if (!active() || verifying) return;
        if (event.candidate?.type === 'relay') {
          const protocol = event.candidate.protocol;
          verifying = true;
          void Promise.resolve().then(() => options.verify?.(controller.signal)).then(() => {
            if (active()) finish(protocol === 'udp' || protocol === 'tcp' ? { status: 'allocated', protocol } : { status: 'allocated' });
          }).catch(error => { if (!done) finish({ status: error instanceof TurnDiagnosticUnavailable ? error.status : 'failed' }); });
        } else if (!event.candidate) finish({ status: 'failed' });
      };
      peer.onicegatheringstatechange = () => { if (active() && !verifying && peer?.iceGatheringState === 'complete') finish({ status: 'failed' }); };
      peer.oniceconnectionstatechange = () => { if (active() && peer?.iceConnectionState === 'failed') finish({ status: 'failed' }); };
      // No remote description or remote peer is needed to allocate a relay.
      channel = peer.createDataChannel('tavern-turn-diagnostic', { negotiated: true, id: 0 });
      const offer = await peer.createOffer();
      if (!active()) return;
      await peer.setLocalDescription(offer);
      active();
    })().catch(error => { if (!done) finish({ status: error instanceof TurnDiagnosticUnavailable ? error.status : 'failed' }); });
  });
}
