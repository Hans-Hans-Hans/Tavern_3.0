import { useEffect, useState } from 'react';
import type { MatrixCall } from 'matrix-js-sdk';
import { callSnapshot } from '@/lib/calls';
import { CallStreamQualityController, streamQualityPresets, type StreamQualityKind, type StreamQualityPreset, type StreamQualitySnapshot } from '@/lib/call-stream-quality';

export function useCallStreamQuality(call: MatrixCall | null) {
  const [controller, setController] = useState<CallStreamQualityController | null>(null), [snapshot, setSnapshot] = useState<StreamQualitySnapshot | null>(null);
  useEffect(() => {
    if (!call || call.state === 'ended') { setController(null); setSnapshot(null); return; }
    const next = new CallStreamQualityController(call, () => callSnapshot().call === call);
    setController(next); const off = next.subscribe(setSnapshot);
    return () => { off(); next.dispose(); };
  }, [call]);
  return { controller, snapshot };
}
const number = (value: number | null | undefined, unit: string) => value == null ? 'Not reported' : `${Math.round(value * 10) / 10}${unit}`;
export function CallStreamQuality({ controller, snapshot }: ReturnType<typeof useCallStreamQuality>) {
  const [error, setError] = useState('');
  if (!controller || !snapshot) return null;
  return <section className='call-stream-quality' aria-label='Outgoing stream quality'><h3>Outgoing video quality</h3>
    <p className='call-control-caption'>These choices apply to this call’s existing camera and shared screen. Actual capture can differ from the requested size; the network can send less than its limit. Values are checked when quality or the video source changes.</p>
    {(['camera', 'screen'] as StreamQualityKind[]).map(kind => {
      const state = snapshot[kind], preset = streamQualityPresets[state.preset], name = kind === 'camera' ? 'Camera' : 'Screen share';
      const options: StreamQualityPreset[] = kind === 'camera' ? ['automatic', 'low', 'balanced', 'detail'] : ['automatic', 'low', 'balanced', 'detail', 'text'];
      return <fieldset key={kind}><legend>{name}</legend><label>{name} quality<select value={state.preset} aria-busy={state.status === 'applying'} onChange={event => { setError(''); void controller.set(kind, event.target.value as StreamQualityPreset).catch(failure => setError((failure as Error).message)); }}>{options.map(value => <option key={value} value={value}>{streamQualityPresets[value].label}</option>)}</select></label>
        {state.preset !== 'automatic' && <p className='call-quality-requested'>Requested: up to {preset.width} × {preset.height}, {preset.frameRate} fps; {preset.maxBitrate / 1_000_000} Mbps total send limit.</p>}
        <p role='status' className='call-quality-outcome'>{state.status === 'applying' ? 'Applying quality settings…' : state.status === 'waiting' ? 'Waiting for your video source.' : state.status === 'applied' ? state.preset === 'automatic' ? 'Call default constraints and send limits restored.' : 'Capture request and send limits applied.' : state.status === 'partial' ? 'Some quality settings could not be applied.' : state.status === 'unsupported' ? 'This browser does not support these quality changes.' : 'The quality change could not be completed.'}</p>
        {state.available && <dl><div><dt>Actual capture size</dt><dd>{state.capture?.width != null && state.capture?.height != null ? `${state.capture.width} × ${state.capture.height}` : 'Not reported'}</dd></div><div><dt>Actual capture frame rate</dt><dd>{number(state.capture?.frameRate, ' fps')}</dd></div><div><dt>Reported total send limit</dt><dd>{state.limits.length && state.limits.every(value => value.maxBitrate !== null) ? number(state.limits.reduce((sum, value) => sum + value.maxBitrate!, 0) / 1_000_000, ' Mbps') : 'Not reported'}</dd></div><div><dt>Reported frame-rate limit</dt><dd>{state.limits.length && state.limits.every(value => value.maxFramerate !== null) ? number(Math.max(...state.limits.map(value => value.maxFramerate!)), ' fps') : 'Not reported'}</dd></div></dl>}
        {state.available && !state.enabled && <p className='call-control-caption'>This video track is disabled. Changing quality does not enable it.</p>}
        {state.messages.map(message => <p key={message} className='call-control-caption'>{message}</p>)}
      </fieldset>;
    })}{error && <p role='alert' className='connect-error'>{error}</p>}
  </section>;
}
