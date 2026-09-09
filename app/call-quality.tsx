import { useEffect, useState } from 'react';
import type { MatrixCall } from 'matrix-js-sdk';
import { watchCallQuality, type CallQuality } from '@/lib/call-quality';

const metric = (value: number | null | undefined, unit: string) => value === null || value === undefined ? 'Not reported yet' : value + ' ' + unit;
export function CallConnectionDetails({ call }: { call: MatrixCall }) {
  const [quality, setQuality] = useState<CallQuality | null>(null);
  useEffect(() => { setQuality(null); return watchCallQuality(call, setQuality); }, [call]);
  return <details className='call-connection'><summary>Connection details{quality?.connection && quality.connection !== 'unavailable' ? ' · ' + quality.connection : ''}</summary>
    <dl><div><dt>Connection</dt><dd>{quality?.connection || 'Waiting for connection'}</dd></div><div><dt>ICE transport</dt><dd>{quality?.ice || 'Waiting for connection'}</dd></div><div><dt>Local route</dt><dd>{quality?.localRoute === 'relay' ? 'TURN relay' : quality?.localRoute || 'Not reported yet'}</dd></div><div><dt>Round-trip time</dt><dd>{metric(quality?.roundTripMs, 'ms')}</dd></div><div><dt>Receive jitter (highest stream)</dt><dd>{metric(quality?.jitterMs, 'ms')}</dd></div><div><dt>Receive packet loss (recent interval)</dt><dd>{metric(quality?.receiveLossPercent, '%')}</dd></div><div><dt>Download media rate</dt><dd>{metric(quality?.downloadKbps, 'kbps')}</dd></div><div><dt>Upload media rate</dt><dd>{metric(quality?.uploadKbps, 'kbps')}</dd></div></dl>
    <p className='call-control-caption'>{quality?.error || 'Measured on this device about every two seconds. Rates and packet loss need two samples; browsers may omit individual measurements. Connection addresses are omitted from this panel.'}</p>
  </details>;
}
