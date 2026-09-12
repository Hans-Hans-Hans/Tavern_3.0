import { expect, test } from '@playwright/test';

test('deafen silences the actual WebRTC receiver stream and restores sound without another connection or capture', async ({ page }) => {
  await page.route('**/output-gate-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="module">import { createConferenceOutputGate } from "/lib/conference-output.ts"; window.createGate=createConferenceOutputGate;</script>' }));
  await page.goto('/output-gate-fixture'); await page.waitForFunction(() => (window as any).createGate);
  const result = await page.evaluate(async () => {
    // A silent sink advances Web Audio even on a runner without a speaker.
    const context = new AudioContext({ sinkId: { type: 'none' } } as AudioContextOptions), source = new RTCPeerConnection({ iceServers: [] }), destination = new RTCPeerConnection({ iceServers: [] });
    const oscillator = context.createOscillator(), output = context.createMediaStreamDestination(), gate = (window as any).createGate();
    let remote: MediaStreamTrack | undefined;
    const pending: Promise<unknown>[] = [];
    source.onicecandidate = event => { if (event.candidate) pending.push(destination.addIceCandidate(event.candidate)); };
    destination.onicecandidate = event => { if (event.candidate) pending.push(source.addIceCandidate(event.candidate)); };
    destination.ontrack = event => { remote = event.track; };
    const until = async (predicate: () => boolean, timeout = 6000) => { const end = performance.now() + timeout; while (performance.now() < end) { if (predicate()) return true; await new Promise(resolve => setTimeout(resolve, 40)); } return false; };
    try {
      oscillator.frequency.value = 440; oscillator.connect(output); oscillator.start(); await context.resume();
      source.addTrack(output.stream.getAudioTracks()[0], output.stream);
      await source.setLocalDescription(await source.createOffer()); await destination.setRemoteDescription(source.localDescription!);
      await destination.setLocalDescription(await destination.createAnswer()); await source.setRemoteDescription(destination.localDescription!);
      await Promise.all(pending);
      if (!await until(() => !!remote && source.connectionState === 'connected' && destination.connectionState === 'connected')) return { connected: false };
      const element = document.createElement('audio'); element.srcObject = new MediaStream([remote!]); element.volume = 0; document.body.append(element); await element.play();
      const analyser = context.createAnalyser(); analyser.fftSize = 1024;
      const playback = context.createMediaStreamSource(new MediaStream([remote!])); playback.connect(analyser);
      const silentOutput = context.createGain(); silentOutput.gain.value = 0; analyser.connect(silentOutput); silentOutput.connect(context.destination);
      const buffer = new Float32Array(analyser.fftSize);
      const audible = () => { analyser.getFloatTimeDomainData(buffer); return buffer.some(value => Math.abs(value) > 0.001); };
      const before = await until(audible); gate.set(true, [remote!]);
      let silentSamples = 0;
      const silent = await until(() => { silentSamples = audible() ? 0 : silentSamples + 1; return silentSamples >= 8; });
      const connected = destination.connectionState === 'connected', disabled = remote!.enabled === false;
      gate.set(false, [remote!]); const after = await until(audible);
      playback.disconnect(); element.pause(); element.remove();
      if (!before || !after) {
        const received = [...(await destination.getStats()).values()].find(item => item.type === 'inbound-rtp' && item.kind === 'audio');
        throw new Error('Audio fixture: ' + JSON.stringify({ state: context.state, time: context.currentTime, muted: remote!.muted, received: received?.bytesReceived ?? null, energy: received?.totalAudioEnergy ?? null }));
      }
      return { before, silent, connected, disabled, after };
    } finally { gate.stop(); oscillator.stop(); output.stream.getTracks().forEach(track => track.stop()); source.close(); destination.close(); await context.close(); }
  });
  expect(result).toEqual({ before: true, silent: true, connected: true, disabled: true, after: true });
});
