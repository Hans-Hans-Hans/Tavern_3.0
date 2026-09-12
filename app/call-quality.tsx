import { useEffect, useMemo, useState } from 'react';
import type { MatrixCall } from 'matrix-js-sdk';
import { watchCallQuality, type CallQuality } from '@/lib/call-quality';
import { callSnapshot, subscribeCalls } from '@/lib/calls';
import { getMatrixClient } from '@/lib/matrix';
import { accountArtworkOwner } from '@/lib/api';

const metric = (value: number | null | undefined, unit: string) => value === null || value === undefined ? 'Not reported yet' : value + ' ' + unit;
export function useCallConnectionQuality(call: MatrixCall | null) {
  const ownerCurrent = useMemo(() => {
    const client = getMatrixClient(), owner = accountArtworkOwner(), actor = client?.getUserId(), device = client?.getDeviceId(), base = client?.getHomeserverUrl?.();
    return () => callSnapshot().call === call && getMatrixClient() === client && accountArtworkOwner() === owner
      && client?.getUserId() === actor && client?.getDeviceId() === device && client?.getHomeserverUrl?.() === base;
  }, [call]);
  const [sample, setSample] = useState<{ call: MatrixCall; current: () => boolean; quality: CallQuality } | null>(null);
  useEffect(() => {
    setSample(null);
    if (!call) return;
    let alive = true;
    const current = () => alive && ownerCurrent();
    const unsubscribe = subscribeCalls(() => { if (!current()) setSample(null); });
    const stop = watchCallQuality(call, quality => setSample(current() ? { call, current, quality } : null));
    return () => { alive = false; stop(); unsubscribe(); };
  }, [call, ownerCurrent]);
  return sample?.call === call && sample.current() ? sample.quality : null;
}

export function CallConnectionDetails({ quality }: { quality: CallQuality | null }) {
  return <details className='call-connection'><summary>Connection details{quality?.connection && quality.connection !== 'unavailable' ? ' · ' + quality.connection : ''}</summary>
    <dl><div><dt>Connection</dt><dd>{quality?.connection || 'Waiting for connection'}</dd></div><div><dt>ICE transport</dt><dd>{quality?.ice || 'Waiting for connection'}</dd></div><div><dt>ICE gathering</dt><dd>{quality?.gathering || 'Waiting for connection'}</dd></div><div><dt>Signaling</dt><dd>{quality?.signaling || 'Not reported yet'}</dd></div><div><dt>Local description</dt><dd>{quality?.localDescription || 'Not reported yet'}</dd></div><div><dt>Remote description</dt><dd>{quality?.remoteDescription || 'Not reported yet'}</dd></div><div><dt>Gathered relay candidates</dt><dd>{quality?.gatheredRelayCandidates ?? 'Not reported yet'}</dd></div><div><dt>ICE error codes</dt><dd>{quality?.iceErrors?.length ? quality.iceErrors.join(', ') : 'None recorded'}</dd></div><div><dt>Local ICE candidates</dt><dd>{quality?.localCandidates ?? 'Not reported yet'}</dd></div><div><dt>Local relay candidates</dt><dd>{quality?.localRelayCandidates ?? 'Not reported yet'}</dd></div><div><dt>Remote ICE candidates</dt><dd>{quality?.remoteCandidates ?? 'Not reported yet'}</dd></div><div><dt>Local route</dt><dd>{quality?.localRoute === 'relay' ? 'TURN relay' : quality?.localRoute || 'Not reported yet'}</dd></div><div><dt>Round-trip time</dt><dd>{metric(quality?.roundTripMs, 'ms')}</dd></div><div><dt>Receive jitter (highest stream)</dt><dd>{metric(quality?.jitterMs, 'ms')}</dd></div><div><dt>Receive packet loss (recent interval)</dt><dd>{metric(quality?.receiveLossPercent, '%')}</dd></div><div><dt>Download media rate</dt><dd>{metric(quality?.downloadKbps, 'kbps')}</dd></div><div><dt>Upload media rate</dt><dd>{metric(quality?.uploadKbps, 'kbps')}</dd></div></dl>
    <p className='call-control-caption'>{quality?.error || 'Measured on this device about every two seconds. Rates and packet loss need two samples; browsers may omit individual measurements. Candidate counts cover the current bounded browser report and do not prove a working media path. Connection addresses are omitted from this panel.'}</p>
  </details>;
}
