import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { CallFeed } from 'matrix-js-sdk/lib/webrtc/callFeed';
import { SDPStreamMetadataPurpose } from 'matrix-js-sdk/lib/webrtc/callEventTypes';
import { CallPanel } from '../../../app/call-panel';
import '../../../app/globals.css';

class Events {
  listeners = new Map<string, Set<(...args: any[]) => void>>();
  on(type: string, listener: (...args: any[]) => void) { const set = this.listeners.get(type) || new Set(); set.add(listener); this.listeners.set(type, set); return this; }
  off(type: string, listener: (...args: any[]) => void) { this.listeners.get(type)?.delete(listener); return this; }
  emit(type: string) { for (const listener of this.listeners.get(type) || []) listener(); }
}
async function gathered(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', changed); reject(new Error('Synthetic peer did not gather candidates')); }, 5000);
    const changed = () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); resolve(); } };
    peer.addEventListener('icegatheringstatechange', changed);
  });
}
async function negotiate(first: RTCPeerConnection, second: RTCPeerConnection) {
  await first.setLocalDescription(await first.createOffer()); await gathered(first); await second.setRemoteDescription(first.localDescription!);
  await second.setLocalDescription(await second.createAnswer()); await gathered(second); await first.setRemoteDescription(second.localDescription!);
}
export function mountFixture() {
  const w = window as any; w.fixtureListeners = new Set(); w.fixtureCaptureRequests = 0;
  navigator.mediaDevices.getUserMedia = async () => { w.fixtureCaptureRequests++; throw new Error('Quality must not request camera or microphone capture'); };
  navigator.mediaDevices.getDisplayMedia = async () => { w.fixtureCaptureRequests++; throw new Error('Quality must not request screen capture'); };
  const members = [{ userId: '@me:local', name: 'You', membership: 'join' }, { userId: '@peer:local', name: 'Peer', membership: 'join' }];
  const room = { roomId: '!dm:local', name: 'Synthetic quality call', getMyMembership: () => 'join', getJoinedMembers: () => members, getMember: (id: string) => members.find(member => member.userId === id) };
  w.fixtureClient = { getUserId: () => '@me:local', getDeviceId: () => 'TEST', getRoom: () => room };
  w.fixtureSnapshot = { call: null, error: '', busy: false, media: { audioInput: '', videoInput: '', audioOutput: '', outputVolume: 0, deafened: false, pushToTalk: false, noiseSuppression: true, echoCancellation: true, autoGainControl: true } };
  function Fixture() {
    const [visible, setVisible] = useState(false), [error, setError] = useState(''), [starting, setStarting] = useState(false);
    async function start() {
      setStarting(true); setError('');
      try {
        const timers: number[] = [], owned: MediaStream[] = [];
        function canvasStream(label: string) {
          const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720; const drawing = canvas.getContext('2d')!;
          let frame = 0; const paint = () => { drawing.fillStyle = frame++ % 2 ? '#284539' : '#2f5145'; drawing.fillRect(0, 0, canvas.width, canvas.height); drawing.fillStyle = '#fff'; drawing.font = '40px sans-serif'; drawing.fillText(label + ' ' + frame, 100, 200); };
          paint(); timers.push(window.setInterval(paint, 33)); const stream = canvas.captureStream(30); owned.push(stream); return stream;
        }
        const context = new AudioContext(); await context.resume(); const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
        const cameraStream = canvasStream('Existing camera source'), camera = cameraStream.getVideoTracks()[0], audio = destination.stream.getAudioTracks()[0];
        const stream = new MediaStream([camera, audio]), first = new RTCPeerConnection(), second = new RTCPeerConnection(), remote = new MediaStream(); owned.push(destination.stream);
        second.ontrack = event => remote.addTrack(event.track);
        const cameraSender = first.addTrack(camera, stream), audioSender = first.addTrack(audio, stream); await negotiate(first, second);
        const feed = new CallFeed({ client: w.fixtureClient, roomId: room.roomId, userId: '@me:local', deviceId: 'TEST', stream, purpose: SDPStreamMetadataPurpose.Usermedia, audioMuted: false, videoMuted: false });
        const feeds = [feed], call = Object.assign(new Events(), { callId: 'quality-call', roomId: room.roomId, state: 'connected', peerConn: first, localUsermediaStream: stream, localUsermediaFeed: feed, localScreensharingStream: undefined as MediaStream | undefined, localScreensharingFeed: undefined as CallFeed | undefined, getCurrentCallStats: async () => [...(await first.getStats()).values()], getFeeds: () => feeds, isMicrophoneMuted: () => !audio.enabled, isLocalVideoMuted: () => !camera.enabled, isScreensharing: () => !!call.localScreensharingStream });
        w.fixtureQuality = { call, first, second, remote, camera, cameraSender, audio, audioSender, originalCapture: camera.getConstraints(), originalEncoding: cameraSender.getParameters().encodings, originalAudio: audioSender.getParameters().encodings };
        w.fixtureAddScreen = async () => {
          if (call.localScreensharingStream) return;
          const screenStream = canvasStream('Existing shared screen'), screen = screenStream.getVideoTracks()[0], sender = first.addTrack(screen, screenStream); await negotiate(first, second);
          const screenFeed = new CallFeed({ client: w.fixtureClient, roomId: room.roomId, userId: '@me:local', deviceId: 'TEST', stream: screenStream, purpose: SDPStreamMetadataPurpose.Screenshare, audioMuted: true, videoMuted: false });
          Object.assign(w.fixtureQuality, { screen, screenSender: sender }); call.localScreensharingStream = screenStream; call.localScreensharingFeed = screenFeed; feeds.push(screenFeed); call.emit('feeds_changed'); for (const notify of w.fixtureListeners) notify();
        };
        w.fixtureEndCall = () => { call.state = 'ended'; call.emit('hangup'); setVisible(false); w.fixtureSnapshot.call = null; for (const notify of w.fixtureListeners) notify(); first.close(); second.close(); feeds.forEach(value => value.dispose()); owned.forEach(value => value.getTracks().forEach(track => track.stop())); remote.getTracks().forEach(track => track.stop()); timers.forEach(clearInterval); oscillator.stop(); void context.close(); };
        w.fixtureSnapshot.call = call; setVisible(true);
      } catch (error) { setError((error as Error).message); } finally { setStarting(false); }
    }
    return <><button disabled={starting} onClick={() => void start()}>Start synthetic quality call</button><button onClick={() => { void w.fixtureAddScreen?.().catch((failure: Error) => setError(failure.message)); }}>Add existing synthetic screen</button><button onClick={() => setVisible(value => !value)}>Toggle quality panel mount</button>{error && <p role='alert'>{error}</p>}{visible && <CallPanel/>}<Toaster/></>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
