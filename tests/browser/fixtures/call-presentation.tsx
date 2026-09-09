import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { CallFeed } from 'matrix-js-sdk/lib/webrtc/callFeed';
import { SDPStreamMetadataPurpose } from 'matrix-js-sdk/lib/webrtc/callEventTypes';
import { CallPanel } from '../../../app/call-panel';
import '../../../app/globals.css';

async function gathered(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', changed); reject(new Error('Synthetic test peer did not gather ICE candidates')); }, 5000);
    const changed = () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); resolve(); } };
    peer.addEventListener('icegatheringstatechange', changed);
  });
}
export function mountFixture() {
  const w = window as any; w.fixtureListeners = new Set(); w.fixtureCaptureRequests = 0;
  navigator.mediaDevices.getUserMedia = async () => { w.fixtureCaptureRequests++; throw new Error('The presentation fixture must not request microphone or camera capture'); };
  navigator.mediaDevices.getDisplayMedia = async () => { w.fixtureCaptureRequests++; throw new Error('The presentation fixture must not request screen capture'); };
  const members = [{ userId: '@me:local', name: 'You', membership: 'join' }, { userId: '@peer:local', name: 'Peer', membership: 'join' }];
  const room = { roomId: '!dm:local', name: 'Synthetic call', getMyMembership: () => 'join', getJoinedMembers: () => members, getMember: (id: string) => members.find(member => member.userId === id) };
  w.fixtureClient = { getUserId: () => '@me:local', getDeviceId: () => 'TEST', getRoom: () => room };
  w.fixtureSnapshot = { call: null, error: '', busy: false, media: { audioInput: '', videoInput: '', audioOutput: '', outputVolume: 0, deafened: false, pushToTalk: false, noiseSuppression: true, echoCancellation: true, autoGainControl: true } };
  function Fixture() {
    const [visible, setVisible] = useState(false), [error, setError] = useState(''), [starting, setStarting] = useState(false);
    async function start() {
      setStarting(true); setError('');
      try {
        const context = new AudioContext(); await context.resume();
        const oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination(); oscillator.frequency.value = 440; gain.gain.value = 0.05; oscillator.connect(gain).connect(destination); oscillator.start();
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; const drawing = canvas.getContext('2d')!;
        let frame = 0; const paint = () => { drawing.fillStyle = frame++ % 2 ? '#284539' : '#2f5145'; drawing.fillRect(0, 0, 320, 180); drawing.fillStyle = '#ffffff'; drawing.font = '24px sans-serif'; drawing.fillText('Live synthetic video', 40, 100); };
        paint(); const painting = setInterval(paint, 100), video = canvas.captureStream(10), stream = new MediaStream([...video.getVideoTracks(), ...destination.stream.getAudioTracks()]);
        const first = new RTCPeerConnection(), second = new RTCPeerConnection(), remote = new MediaStream();
        second.ontrack = event => remote.addTrack(event.track);
        for (const track of stream.getTracks()) { first.addTrack(track, stream); second.addTrack(track, stream); }
        await first.setLocalDescription(await first.createOffer()); await gathered(first); await second.setRemoteDescription(first.localDescription!);
        await second.setLocalDescription(await second.createAnswer()); await gathered(second); await first.setRemoteDescription(second.localDescription!);
        const feed = new CallFeed({ client: w.fixtureClient, roomId: room.roomId, userId: '@peer:local', deviceId: 'REMOTE', stream: remote, purpose: SDPStreamMetadataPurpose.Usermedia, audioMuted: false, videoMuted: false });
        w.fixtureFeed = feed; w.fixtureStreams = [stream, remote]; w.fixtureGain = gain; w.fixturePeers = [first, second];
        w.fixtureEndCall = () => { setVisible(false); w.fixtureSnapshot.call = null; for (const notify of w.fixtureListeners) notify(); first.close(); second.close(); feed.dispose(); stream.getTracks().forEach(track => track.stop()); remote.getTracks().forEach(track => track.stop()); clearInterval(painting); oscillator.stop(); void context.close(); };
        w.fixtureSnapshot.call = { callId: 'synthetic-call', roomId: room.roomId, state: 'connected', peerConn: first, getCurrentCallStats: async () => [...(await first.getStats()).values()], getFeeds: () => [feed], isMicrophoneMuted: () => false, isLocalVideoMuted: () => true, isScreensharing: () => false };
        setVisible(true);
      } catch (error) { setError((error as Error).message); } finally { setStarting(false); }
    }
    return <><button disabled={starting} onClick={() => void start()}>Start synthetic call</button><button onClick={() => { w.fixtureGain.gain.value = 0; }}>Silence synthetic audio</button><button onClick={() => { w.fixtureGain.gain.value = 0.05; }}>Resume synthetic audio</button><button onClick={() => setVisible(false)}>Hide call panel</button>{error && <p role='alert'>{error}</p>}{visible && <CallPanel/>}<Toaster/></>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture/>);
}
