import { createRoot } from 'react-dom/client';
import AdminConsole from '../../../app/admin-console';
import { setAccountDevice, setManagedAccount } from '../../../lib/api';
import '../../../app/globals.css';
import '../../../app/product.css';
export function mountFixture(){
 const f:any=(window as any).trafficFixture={peers:[],channels:[],captures:0,sent:0,session:{userId:'@admin:local',deviceId:'TURN-DEVICE',baseUrl:location.origin+'/api/matrix',admin:true,passwordChangeRequired:false,mfaEnrollmentRequired:false}};
 setManagedAccount(true);setAccountDevice(f.session.deviceId);const Candidate=window.RTCIceCandidate;
 class Channel extends EventTarget{readyState='connecting';closed=false;constructor(readonly index:number){super();}send(value:string){f.sent++;f.channels[1-this.index].dispatchEvent(new MessageEvent('message',{data:f.badReceipt?'incorrect':value}));}close(){this.closed=true;this.readyState='closed';}}
 class Peer extends EventTarget{
  index=f.peers.length;remoteDescription:RTCSessionDescriptionInit|null=null;iceConnectionState='new';iceGatheringState='gathering';closed=false;
  constructor(readonly configuration:RTCConfiguration){super();f.peers.push(this);}
  createDataChannel(){const channel=new Channel(this.index);f.channels.push(channel);return channel;}
  async createOffer(){return{type:'offer',sdp:'fixture'};}async createAnswer(){return{type:'answer',sdp:'fixture'};}
  async setLocalDescription(){const event=new Event('icecandidate'),candidate=new Candidate({candidate:'candidate:fixture 1 udp 16777215 192.0.2.123 49160 typ relay raddr 10.0.0.55 rport 3456',sdpMid:'0',sdpMLineIndex:0});Object.defineProperty(event,'candidate',{value:candidate});this.dispatchEvent(event);}
  async setRemoteDescription(value:RTCSessionDescriptionInit){this.remoteDescription=value;if(this.index===0)f.ready=true;}
  async addIceCandidate(){}
  async getStats(){if(f.holdStats)await new Promise<void>(resolve=>f.releaseStats=resolve);if(f.missingStats)return new Map();return new Map([['transport',{type:'transport',selectedCandidatePairId:'pair'}],['pair',{state:'succeeded',localCandidateId:'local',remoteCandidateId:'remote'}],['local',{candidateType:f.nonRelay?'host':'relay',protocol:'udp',address:'192.0.2.123'}],['remote',{candidateType:'relay',protocol:'udp',address:'192.0.2.124'}]]);}
  close(){this.closed=true;this.iceConnectionState='closed';}
 }
 window.RTCPeerConnection=Peer as any;navigator.mediaDevices.getUserMedia=async()=>{f.captures++;throw Error('Forbidden capture');};navigator.mediaDevices.getDisplayMedia=async()=>{f.captures++;throw Error('Forbidden capture');};
 f.exchange=()=>{for(const channel of f.channels){channel.readyState='open';channel.dispatchEvent(new Event('open'));}};
 f.replaceAccount=()=>{setAccountDevice('OTHER');setAccountDevice('TURN-DEVICE');};
 createRoot(document.getElementById('root')!).render(<AdminConsole session={f.session}/>);
}
