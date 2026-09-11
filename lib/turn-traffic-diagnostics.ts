import { checkedTurnServers, TurnDiagnosticUnavailable, turnDiagnosticTimeout } from './turn-diagnostics';
export type TurnTrafficResult = { status: 'exchanged'; protocol?: 'udp' | 'tcp' } | { status: 'failed' | 'timeout' | 'cancelled' | 'unavailable' | 'not-configured' | 'unauthorized'; stage: 'credentials' | 'allocation' | 'connection' | 'exchange' | 'verification' };
type Clock = Pick<typeof globalThis, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>;
type Options = { current: () => boolean; prepare: (signal: AbortSignal) => Promise<RTCIceServer[]>; verify: (signal: AbortSignal) => Promise<void>; signal: AbortSignal; createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection; clock?: Clock };

/** Two temporary local peers prove bidirectional bytes through selected TURN
 * relays. No tracks, user media, remote user, server mutations or raw reports. */
export function runTurnTrafficDiagnostic(options: Options): Promise<TurnTrafficResult> {
  const clock = options.clock || globalThis, controller = new AbortController();
  return new Promise(resolve => {
    let done = false, stage: Exclude<TurnTrafficResult, { status: 'exchanged' }>['stage'] = 'credentials';
    const peers: RTCPeerConnection[] = [], channels: RTCDataChannel[] = [], cleanup: (() => void)[] = [], waiters = new Set<() => void>();
    const candidates: RTCIceCandidateInit[][] = [[], []], relays = [0, 0], forwarding: Promise<void>[] = [Promise.resolve(), Promise.resolve()];
    let deadline: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
    const current = () => { try { return options.current(); } catch { return false; } };
    const finish = (result: TurnTrafficResult) => {
      if (done) return; done = true; controller.abort(); clock.clearTimeout(deadline); clock.clearInterval(poll); options.signal.removeEventListener('abort', cancel);
      cleanup.forEach(remove => remove()); cleanup.length = 0; waiters.forEach(reject => reject()); waiters.clear(); candidates.forEach(queue => { queue.length = 0; });
      for (const channel of channels) { try { channel.close(); } catch { /* Already closed. */ } }
      for (const peer of peers) { try { peer.close(); } catch { /* Already closed. */ } }
      resolve(current() ? result : { status: 'cancelled', stage });
    };
    const cancel = () => finish({ status: 'cancelled', stage });
    const active = () => { if (done) return false; if (!current() || options.signal.aborted) { cancel(); return false; } return true; };
    const fail = () => finish({ status: 'failed', stage });
    const listen = (target: EventTarget, event: string, listener: EventListener) => { target.addEventListener(event, listener); cleanup.push(() => target.removeEventListener(event, listener)); };
    const until = (target: EventTarget, event: string, ready: (event?: Event) => boolean) => new Promise<void>((resolve, reject) => {
      const stop = () => reject(new Error('Diagnostic stopped.')); waiters.add(stop);
      const check = (event?: Event) => { if (!active()) return; try { if (ready(event)) { waiters.delete(stop); resolve(); } } catch { fail(); } };
      listen(target, event, check); check();
    });
    const flush = (index: number) => {
      if (!active() || !peers[index]?.remoteDescription) return;
      const batch = candidates[index].splice(0);
      forwarding[index] = forwarding[index].then(async () => { for (const candidate of batch) { if (!active()) return; await peers[index].addIceCandidate(candidate); if (!active()) return; } }).catch(() => { if (active()) fail(); });
    };
    options.signal.addEventListener('abort', cancel, { once: true }); if (!active()) return;
    deadline = clock.setTimeout(() => finish({ status: 'timeout', stage }), turnDiagnosticTimeout);
    poll = clock.setInterval(() => { active(); }, 250);
    void (async () => {
      if (!options.createPeer && typeof RTCPeerConnection === 'undefined') throw new TurnDiagnosticUnavailable('unavailable');
      const servers = checkedTurnServers(await options.prepare(controller.signal)); if (!active()) return;
      const bytes = crypto.getRandomValues(new Uint8Array(16)), nonce = [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''); bytes.fill(0);
      stage = 'allocation';
      for (let index = 0; index < 2; index++) {
        const peer = (options.createPeer || (configuration => new RTCPeerConnection(configuration)))({ iceServers: servers, iceTransportPolicy: 'relay', iceCandidatePoolSize: 0 }); peers.push(peer);
        if (!active()) return;
        listen(peer, 'icecandidate', event => {
          if (!active()) return; const candidate = (event as RTCPeerConnectionIceEvent).candidate;
          if (!candidate) { if (!relays[index]) fail(); return; }
          if (candidate.type !== 'relay') { fail(); return; }
          if (++relays[index] > 32) { fail(); return; }
          candidates[1 - index].push(candidate.toJSON()); flush(1 - index);
        });
        listen(peer, 'iceconnectionstatechange', () => { if (active() && ['failed', 'closed'].includes(peer.iceConnectionState)) fail(); });
        listen(peer, 'icegatheringstatechange', () => { if (active() && peer.iceGatheringState === 'complete' && !relays[index]) fail(); });
        const channel = peer.createDataChannel('tavern-turn-traffic', { negotiated: true, id: 0 }); channels.push(channel);
        listen(channel, 'error', () => { if (active()) fail(); }); listen(channel, 'close', () => { if (active()) fail(); });
      }
      const receipts = Promise.all(channels.map((channel, index) => until(channel, 'message', event => {
        if (!event) return false; if ((event as MessageEvent).data !== nonce + ':' + (1 - index)) throw new Error('Unexpected diagnostic response.'); return true;
      }))); receipts.catch(() => {});
      const offer = await peers[0].createOffer(); if (!active()) return;
      await peers[0].setLocalDescription(offer); if (!active()) return;
      await peers[1].setRemoteDescription(offer); if (!active()) return; flush(1);
      const answer = await peers[1].createAnswer(); if (!active()) return;
      await peers[1].setLocalDescription(answer); if (!active()) return;
      await peers[0].setRemoteDescription(answer); if (!active()) return; flush(0);
      stage = 'connection'; await Promise.all(channels.map(channel => until(channel, 'open', () => channel.readyState === 'open'))); if (!active()) return;
      stage = 'exchange'; channels.forEach((channel, index) => channel.send(nonce + ':' + index)); await receipts; if (!active()) return;
      stage = 'verification';
      let protocol: 'udp' | 'tcp' | undefined;
      for (let index = 0; index < peers.length; index++) {
        let stats: RTCStatsReport;
        try { stats = await peers[index].getStats(); } catch { if (active()) finish({ status: 'unavailable', stage }); return; }
        if (!active()) return;
        const rows: RTCStats[] = []; stats.forEach(row => { if (rows.length <= 2000) rows.push(row); });
        if (rows.length > 2000) { finish({ status: 'unavailable', stage }); return; }
        const transports = rows.filter((row: any) => row.type === 'transport' && row.selectedCandidatePairId) as (RTCTransportStats & { selectedCandidatePairId: string })[];
        const selected = [...new Set(transports.map(transport => transport.selectedCandidatePairId))];
        const pair = selected.length === 1 ? stats.get(selected[0]) : null;
        const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
        if (!pair || !local?.candidateType || !remote?.candidateType || !pair.state || ['waiting', 'in-progress', 'frozen'].includes(pair.state)) { finish({ status: 'unavailable', stage }); return; }
        if (pair.state !== 'succeeded' || local.candidateType !== 'relay' || remote.candidateType !== 'relay') { fail(); return; }
        const measured = local.protocol === 'udp' || local.protocol === 'tcp' ? local.protocol : undefined;
        protocol = index === 0 ? measured : protocol === measured ? protocol : undefined;
      }
      stage = 'verification'; await options.verify(controller.signal); if (!active()) return;
      finish(protocol ? { status: 'exchanged', protocol } : { status: 'exchanged' });
    })().catch(error => { if (!done) finish({ status: error instanceof TurnDiagnosticUnavailable ? error.status : 'failed', stage }); });
  });
}
