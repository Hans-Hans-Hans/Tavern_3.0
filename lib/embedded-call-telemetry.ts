import { CALL_TELEMETRY_TYPE, CALL_TELEMETRY_BIND, CALL_TELEMETRY_READY, TELEMETRY_LIMIT, conferenceFailure, emptyConferenceMetrics, parseConferenceTelemetry, telemetryNonce, telemetryString, type ConferenceFailure, type ConferenceMetrics, type ConferenceParticipant } from './conference-telemetry-protocol.js';

// These objects belong to pinned Element Call. Only its existing attested
// members, public LiveKit track APIs, and observable cleanup scope are observed.
type Native = any;
const installations = new WeakMap<object, () => void>();
const sequences = new WeakMap<object, { binding: string; value: number }>();
const participantEvents = ['isSpeakingChanged', 'trackMuted', 'trackUnmuted', 'trackPublished', 'trackUnpublished', 'trackSubscribed', 'trackUnsubscribed', 'localTrackPublished', 'localTrackUnpublished'];
const bool = (v: unknown) => typeof v === 'boolean' ? v : null;
const maxMetric = (values: number[]) => values.length ? Math.round(Math.max(...values) * 100) / 100 : null;
const metric = (v: unknown, scale = 1) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v * scale <= 120_000 ? v * scale : null;

export function attachEmbeddedCallTelemetry(scope: Native, matrixRoom: Native, view: Native, host: Window = window) {
  const cleanups: (() => void)[] = []; let stop = () => {};
  try {
    const url = new URL(host.location.href), params = new URLSearchParams(url.hash.replace(/^#\??/, ''));
    const widgetId = params.get('widgetId'), session = params.get('tavernTelemetry'), roomId = params.get('roomId'), parentUrl = params.get('parentUrl');
    if (host.parent === host || url.pathname !== '/element-call/index.html' || !telemetryNonce(widgetId) || !telemetryNonce(session) || !parentUrl || new URL(parentUrl).origin !== url.origin || roomId !== matrixRoom.roomId) return view;
    if (!view.localMatrixLivekitMember$?.subscribe || !view.remoteMatrixLivekitMembers$?.subscribe || typeof scope.onEnd !== 'function') return view;
    const client = matrixRoom.client, actor = client?.getUserId(), device = client?.getDeviceId(), base = client?.getHomeserverUrl();
    if (!telemetryString(actor, 255) || !telemetryString(device, 255) || client.getRoom(roomId) !== matrixRoom) return view;
    installations.get(host)?.();
    const sequence = sequences.get(host)?.binding === url.href ? sequences.get(host)! : { binding: url.href, value: 0 }; sequences.set(host, sequence);
    let stopped = false, revision = 0, scheduled: ReturnType<typeof setTimeout> | undefined, gathering = false;
    let metrics = emptyConferenceMetrics(), document = '';
    let failure: ConferenceFailure | null = null;
    const nested = new Map<Native, () => void>(), trackCounters = new WeakMap<object, Map<string, { received: number; lost: number }>>(), statsReads = new WeakMap<object, Promise<Native>>();
    const value = (observable: Native) => observable?.value;
    const members = () => { const local = value(view.localMatrixLivekitMember$), remote = value(view.remoteMatrixLivekitMembers$); return [...(local ? [local] : []), ...(Array.isArray(remote) ? remote.slice(0, TELEMETRY_LIMIT) : [])]; };
    const entries = () => {
      const result: { member: Native; participant: Native; connection: Native; membership: Native; nativeMember: Native; data: ConferenceParticipant }[] = [], seen = new Set<string>();
      for (const member of members()) {
        const membership = value(member.membership$), participant = value(member.participant?.value$), connection = value(member.connection$);
        const nativeMember = matrixRoom.getMember(member.userId), room = connection?.livekitRoom;
        if (!membership || !participant || !room || room.state !== 'connected' || nativeMember?.membership !== 'join' || membership.userId !== member.userId || membership.rtcBackendIdentity !== participant.identity ||
            !telemetryString(participant.identity) || seen.has(participant.identity) || !telemetryString(member.userId, 255) || !telemetryString(membership.deviceId, 255)) continue;
        const audio = participant.getTrackPublication('microphone'), camera = participant.getTrackPublication('camera'), screen = participant.getTrackPublication('screen_share');
        const publications = [audio, camera, screen, participant.getTrackPublication('screen_share_audio')].filter(Boolean);
        const encrypted = publications.some(p => p.isEncrypted === false) ? false : publications.length && publications.every(p => p.isEncrypted === true) ? true : null;
        const displayName = telemetryString(nativeMember.name, 160) ? nativeMember.name : member.userId.slice(0, 160);
        const avatar = nativeMember.getMxcAvatarUrl?.(), avatarMxc = telemetryString(avatar, 2048) && /^mxc:\/\/[^\s/?#]+\/[^\s/?#]+$/.test(avatar) ? avatar : null;
        const data: ConferenceParticipant = { identity: participant.identity, userId: member.userId, deviceId: membership.deviceId, displayName, avatarMxc,
          local: participant.isLocal === true, speaking: participant.isSpeaking === true, microphoneEnabled: audio?.isMuted === false, cameraEnabled: camera?.isMuted === false,
          screenShareEnabled: screen?.isMuted === false, e2eeEnabled: bool(room.isE2EEEnabled), encrypted };
        seen.add(participant.identity); result.push({ member, participant, connection, membership, nativeMember, data });
        if (result.length === TELEMETRY_LIMIT) break;
      }
      return result;
    };
    const current = () => !stopped && host.location.href === url.href && matrixRoom.client === client && client.getUserId() === actor && client.getDeviceId() === device && client.getHomeserverUrl() === base && client.getRoom(roomId) === matrixRoom && matrixRoom.getMyMembership() === 'join';
    const emit = () => {
      clearTimeout(scheduled); scheduled = undefined; if (!current()) { stop(); return; } if (!document) return;
      const list = failure ? [] : entries(), active = !failure && value(view.connected$) === true;
      const enabled = !active || !list.length ? null : list.some(p => p.data.e2eeEnabled === false) ? false : list.every(p => p.data.e2eeEnabled === true) ? true : null;
      const remote = value(view.remoteMatrixLivekitMembers$), memberCount = (value(view.localMatrixLivekitMember$) ? 1 : 0) + (Array.isArray(remote) ? remote.length : 0);
      const body = parseConferenceTelemetry({ type: CALL_TELEMETRY_TYPE, version: 1, widgetId, session, roomId, document, sequence: ++sequence.value,
        connected: active, reconnecting: value(view.reconnecting$) === true, participants: list.map(p => p.data), complete: memberCount <= TELEMETRY_LIMIT,
        e2eeEnabled: enabled, metrics: failure ? emptyConferenceMetrics() : metrics, failure });
      if (body) host.parent.postMessage(body, url.origin);
    };
    const schedule = () => { if (!stopped && !scheduled) scheduled = setTimeout(() => { try { emit(); } catch { stop(); } }, 200); };
    const subscribe = (observable: Native, listener: () => void, into = cleanups) => {
      const subscription = observable?.subscribe?.({ next: listener, error: schedule });
      if (subscription) into.push(() => subscription.unsubscribe());
    };
    const refreshMembers = () => {
      revision++; metrics = emptyConferenceMetrics();
      const all = members().slice(0, TELEMETRY_LIMIT), wanted = new Set(all);
      for (const [member, dispose] of nested) if (!wanted.has(member)) { dispose(); nested.delete(member); }
      for (const member of all) if (!nested.has(member)) {
        const disposals: (() => void)[] = []; let prior: Native;
        const changed = () => {
          revision++; metrics = emptyConferenceMetrics();
          const participant = value(member.participant?.value$);
          if (prior !== participant) { if (prior) for (const event of participantEvents) prior.off(event, schedule); prior = participant; if (prior) for (const event of participantEvents) prior.on(event, schedule); }
          schedule();
        };
        nested.set(member, () => { for (const dispose of disposals) dispose(); if (prior) for (const event of participantEvents) prior.off(event, schedule); });
        for (const observable of [member.membership$, member.connection$, member.participant?.value$]) subscribe(observable, changed, disposals);
      }
      schedule();
    };
    const gather = async () => {
      if (!current()) { stop(); return; } if (gathering) return;
      gathering = true;
      const atRevision = revision, all = entries(), tracks = all.map(entry => ({ ...entry, track: entry.participant.getTrackPublication('microphone')?.track })).filter(entry => typeof entry.track?.getRTCStatsReport === 'function');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const reports = await Promise.race([
          Promise.all(tracks.slice(0, 8).map(async entry => {
            let reading = statsReads.get(entry.track);
            if (!reading) {
              reading = Promise.resolve().then(() => entry.track.getRTCStatsReport()).catch(() => null);
              statsReads.set(entry.track, reading);
              void reading.then(() => statsReads.delete(entry.track));
            }
            return { entry, report: await reading };
          })),
          new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 1500); }),
        ]);
        if (!current() || atRevision !== revision) return;
        const latest = entries();
        if (all.length !== latest.length || all.some((entry, index) => entry.participant !== latest[index].participant || entry.connection !== latest[index].connection || entry.membership !== latest[index].membership) ||
            tracks.some(entry => entry.participant.getTrackPublication('microphone')?.track !== entry.track)) { metrics = emptyConferenceMetrics(); schedule(); return; }
        const rtt: number[] = [], jitter: number[] = [], losses: number[] = []; let sampledTracks = 0;
        if (reports) for (const { entry, report } of reports) {
          if (!report || typeof report.values !== 'function') continue;
          sampledTracks++; let count = 0;
          let counters = trackCounters.get(entry.track); if (!counters) { counters = new Map(); trackCounters.set(entry.track, counters); }
          for (const item of report.values()) {
            if (++count > 512) break;
            if (item.type === 'candidate-pair' && item.nominated === true && item.state === 'succeeded') { const time = metric(item.currentRoundTripTime, 1000); if (time !== null) rtt.push(time); }
            if (!['inbound-rtp', 'remote-inbound-rtp'].includes(item.type) || (item.kind ?? item.mediaType) !== 'audio') continue;
            const time = metric(item.roundTripTime, 1000), variation = metric(item.jitter, 1000);
            if (time !== null) rtt.push(time); if (variation !== null) jitter.push(variation);
            const received = item.packetsReceived, lost = item.packetsLost;
            if (typeof received === 'number' && Number.isSafeInteger(received) && received >= 0 && typeof lost === 'number' && Number.isSafeInteger(lost) && lost >= 0 && telemetryString(item.id, 255)) {
              const previous = counters.get(item.id); if (counters.size < 32 || counters.has(item.id)) counters.set(item.id, { received, lost });
              if (previous && received >= previous.received && lost >= previous.lost) { const total = received - previous.received + lost - previous.lost; if (total > 0) losses.push(100 * (lost - previous.lost) / total); }
            } else if (typeof item.fractionLost === 'number' && Number.isFinite(item.fractionLost) && item.fractionLost >= 0 && item.fractionLost <= 1) losses.push(item.fractionLost * 100);
          }
        }
        metrics = { rttMs: maxMetric(rtt), jitterMs: maxMetric(jitter), packetLossPercent: maxMetric(losses), sampledTracks, totalTracks: tracks.length }; schedule();
      } catch { if (current()) { metrics = emptyConferenceMetrics(); schedule(); } }
      finally { clearTimeout(timeout); gathering = false; }
    };
    stop = () => {
      if (stopped) return; stopped = true; revision++; clearTimeout(scheduled);
      for (const dispose of [...cleanups, ...nested.values()]) { try { dispose(); } catch { /* telemetry must not break call teardown */ } } nested.clear();
      if (installations.get(host) === stop) installations.delete(host);
    };
    installations.set(host, stop); scope.onEnd(stop); if (stopped) return view;
    subscribe(view.localMatrixLivekitMember$, refreshMembers); subscribe(view.remoteMatrixLivekitMembers$, refreshMembers);
    subscribe(view.connected$, schedule); subscribe(view.reconnecting$, schedule);
    const heartbeat = setInterval(() => { try { if (!current()) stop(); else schedule(); } catch { stop(); } }, 1000), stats = setInterval(() => { void gather().catch(stop); }, 2000);
    cleanups.push(() => clearInterval(heartbeat), () => clearInterval(stats));
    host.addEventListener('pagehide', stop); cleanups.push(() => host.removeEventListener('pagehide', stop));
    const bind = (event: MessageEvent) => {
      const data = event.data;
      if (!current() || event.source !== host.parent || event.origin !== url.origin || !data || typeof data !== 'object' || Object.keys(data).length !== 6 ||
          data.type !== CALL_TELEMETRY_BIND || data.version !== 1 || data.widgetId !== widgetId || data.session !== session || data.roomId !== roomId || !telemetryNonce(data.document)) return;
      document = data.document; if (failure) { try { emit(); } catch { stop(); } } else schedule();
    };
    host.addEventListener('message', bind); cleanups.push(() => host.removeEventListener('message', bind));
    const fatal = view.fatalError$?.subscribe?.({ next: (error: unknown) => {
      if (error === null || error === undefined || failure || !current()) return;
      try { failure = conferenceFailure(error); emit(); } catch { stop(); }
    }, error: () => {} });
    if (fatal) cleanups.push(() => fatal.unsubscribe());
    // Creation can happen well after iframe load, once the user joins the call.
    host.parent.postMessage({ type: CALL_TELEMETRY_READY, version: 1, widgetId, session, roomId }, url.origin);
    schedule(); void gather().catch(stop);
  } catch { stop(); for (const dispose of cleanups) { try { dispose(); } catch { /* no call-side effects */ } } }
  return view;
}
