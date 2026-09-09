import { createRoot } from 'react-dom/client';
import AdminConsole from '../../../app/admin-console';
import { setAccountDevice, setManagedAccount } from '../../../lib/api';
import '../../../app/globals.css';
import '../../../app/product.css';

export function mountFixture() {
  const f: any = (window as any).turnFixture = { peers: [], captures: 0, listeners: new Set(), session: { userId: '@admin:local', deviceId: 'TURN-DEVICE', baseUrl: location.origin + '/api/matrix', admin: true, passwordChangeRequired: false, mfaEnrollmentRequired: false } };
  setManagedAccount(true); setAccountDevice(f.session.deviceId);
  const Candidate = window.RTCIceCandidate;
  class Peer {
    onicecandidate: any = null; onicegatheringstatechange: any = null; oniceconnectionstatechange: any = null;
    iceGatheringState = 'gathering'; iceConnectionState = 'new'; closed = false; channelClosed = false;
    configuration: RTCConfiguration;
    constructor(configuration: RTCConfiguration) { this.configuration = configuration; f.peers.push(this); }
    createDataChannel() { return { close: () => { this.channelClosed = true; } }; }
    async createOffer() { if (f.offerFailure) throw new Error('credential=SECRET 10.0.0.1 turn:private.invalid'); return { type: 'offer', sdp: 'fixture' }; }
    async setLocalDescription() { f.ready = true; }
    close() { this.closed = true; }
  }
  window.RTCPeerConnection = Peer as any;
  navigator.mediaDevices.getUserMedia = async () => { f.captures++; throw new Error('The diagnostic must not request capture'); };
  navigator.mediaDevices.getDisplayMedia = async () => { f.captures++; throw new Error('The diagnostic must not request screen capture'); };
  f.emit = (kind = 'relay', protocol = 'udp') => {
    const candidate = new Candidate({ candidate: `candidate:fixture 1 ${protocol} 16777215 192.0.2.123 49160 typ ${kind} raddr 10.0.0.55 rport 3456`, sdpMid: '0', sdpMLineIndex: 0 });
    f.peers.at(-1)?.onicecandidate?.({ candidate }); return { type: candidate.type, protocol: candidate.protocol };
  };
  f.replaceAccount = () => { setAccountDevice('OTHER'); setAccountDevice('TURN-DEVICE'); };
  const root = createRoot(document.getElementById('root')!);
  f.demote = () => { f.session = { ...f.session, admin: false }; root.render(<AdminConsole session={f.session}/>); };
  root.render(<AdminConsole session={f.session}/>);
}
