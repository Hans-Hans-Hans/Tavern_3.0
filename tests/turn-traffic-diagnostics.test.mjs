import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';
const shared=loadTs('../lib/turn-diagnostics.ts',{}),{runTurnTrafficDiagnostic}=loadTs('../lib/turn-traffic-diagnostics.ts',{'./turn-diagnostics':shared});
const servers=[{urls:['turn:turn.example:3478?transport=udp'],username:'temporary',credential:'SECRET-FIXTURE'}];
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
function fixture(options={}){
 const f={peers:[],channels:[],current:true,closed:0,channelClosed:0,deadlines:new Map(),polls:new Map(),next:0,sent:[],configurations:[],listeners:0,verified:0};
 class Tracked extends EventTarget{addEventListener(...args){f.listeners++;super.addEventListener(...args);}removeEventListener(...args){f.listeners--;super.removeEventListener(...args);}}
 class Channel extends Tracked{readyState='connecting';constructor(index){super();this.index=index;}send(value){f.sent.push(value);if(!options.noReceipt)f.channels[1-this.index].dispatchEvent(new MessageEvent('message',{data:options.badReceipt?'wrong':value}));}close(){f.channelClosed++;this.readyState='closed';}}
 class Peer extends Tracked{
  iceConnectionState='new';iceGatheringState='gathering';remoteDescription=null;
  constructor(){super();this.index=f.peers.length;f.peers.push(this);}
  createDataChannel(label,config){assert.equal(label,'tavern-turn-traffic');assert.deepEqual(config,{negotiated:true,id:0});const channel=new Channel(this.index);f.channels.push(channel);return channel;}
  async createOffer(){await options.offer?.();return{type:'offer',sdp:'private-SDP'};}async createAnswer(){return{type:'answer',sdp:'private-SDP'};}
  async setLocalDescription(value){this.localDescription=value;const event=new Event('icecandidate');Object.defineProperty(event,'candidate',{value:{type:options.host?'host':'relay',toJSON:()=>({candidate:'private-candidate'})}});this.dispatchEvent(event);}
  async setRemoteDescription(value){this.remoteDescription=value;if(this.index===0){for(const channel of f.channels){channel.readyState='open';channel.dispatchEvent(new Event('open'));}}}
  async addIceCandidate(value){assert.deepEqual(value,{candidate:'private-candidate'});await options.candidate?.();}
  async getStats(){await options.stats?.();if(options.missingStats)return new Map();return new Map([['transport',{type:'transport',selectedCandidatePairId:'pair'}],['pair',{state:'succeeded',localCandidateId:'local',remoteCandidateId:'remote'}],['local',{candidateType:options.nonRelay?'host':'relay',protocol:'udp',address:'PRIVATE-ADDRESS'}],['remote',{candidateType:'relay',protocol:'udp',address:'PRIVATE-ADDRESS'}]]);}
  close(){f.closed++;this.iceConnectionState='closed';}
 }
 const controller=new AbortController();f.controller=controller;
 f.run=()=>runTurnTrafficDiagnostic({signal:controller.signal,current:()=>f.current,prepare:options.prepare|| (async()=>servers),verify:async()=>{f.verified++;await options.verify?.();},createPeer:configuration=>{f.configurations.push(configuration);return new Peer();},clock:{setTimeout(fn){const id=++f.next;f.deadlines.set(id,fn);return id;},clearTimeout(id){f.deadlines.delete(id);},setInterval(fn){const id=++f.next;f.polls.set(id,fn);return id;},clearInterval(id){f.polls.delete(id);}}});return f;
}
const clean=f=>{assert.equal(f.closed,f.peers.length);assert.equal(f.channelClosed,f.channels.length);assert.equal(f.deadlines.size+f.polls.size+f.listeners,0);};
test('two relay-only peers exchange exact nonces both ways and only selected relay metrics survive',async()=>{const f=fixture();assert.deepEqual(await f.run(),{status:'exchanged',protocol:'udp'});assert.equal(f.verified,1);assert.equal(f.sent.length,2);assert.match(f.sent[0],/^[a-f0-9]{32}:0$/);assert.equal(f.sent[1],f.sent[0].slice(0,-1)+'1');assert.ok(f.configurations.every(config=>config.iceTransportPolicy==='relay'&&config.iceCandidatePoolSize===0));clean(f);});
for(const option of ['badReceipt','host','nonRelay'])test(`${option} cannot produce a successful traffic proof`,async()=>{const f=fixture({[option]:true});assert.equal((await f.run()).status,'failed');assert.equal(f.verified,0);clean(f);});
test('open data channels without both receipts remain pending until the original deadline',async()=>{const f=fixture({noReceipt:true}),result=f.run();await flush();assert.equal(f.sent.length,2);[...f.deadlines.values()][0]();assert.deepEqual(await result,{status:'timeout',stage:'exchange'});clean(f);});
test('deadline during credentials suppresses late creation and never exposes raw errors',async()=>{let release;const f=fixture({prepare:()=>new Promise(resolve=>release=resolve)}),result=f.run();[...f.deadlines.values()][0]();assert.deepEqual(await result,{status:'timeout',stage:'credentials'});release(servers);await flush();clean(f);assert.equal(f.peers.length,0);const failed=fixture({prepare:async()=>{throw Error('SECRET private-address private-SDP');}});assert.deepEqual(await failed.run(),{status:'failed',stage:'credentials'});});
for(const phase of ['offer','stats','verify'])test(`owner replacement while ${phase} waits closes peers and prevents stale success`,async()=>{let release;const f=fixture({[phase]:()=>new Promise(resolve=>release=resolve)}),result=f.run();await flush();assert.equal(typeof release,'function');f.current=false;[...f.polls.values()][0]();assert.equal((await result).status,'cancelled');release();await flush();clean(f);});
test('cancelled and demoted administrators cannot publish an exchange success',async()=>{const f=fixture({verify:async()=>{throw new shared.TurnDiagnosticUnavailable('unauthorized');}});assert.deepEqual(await f.run(),{status:'unauthorized',stage:'verification'});clean(f);const cancelled=fixture();cancelled.controller.abort();assert.equal((await cancelled.run()).status,'cancelled');assert.equal(cancelled.peers.length,0);clean(cancelled);});

test('actual bytes with missing route statistics are unavailable rather than reported as failed delivery',async()=>{const f=fixture({missingStats:true});assert.deepEqual(await f.run(),{status:'unavailable',stage:'verification'});assert.equal(f.sent.length,2);clean(f);});
