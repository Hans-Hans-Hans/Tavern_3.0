import { useEffect, useRef, useState } from 'react';
import { Video, X } from 'lucide-react';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { callSnapshot } from '@/lib/calls';
import { toast } from 'sonner';
export function ConferenceButton({roomId,disabled}:{roomId:string;disabled:boolean}){
  const [open,setOpen]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),ref=useRef<HTMLIFrameElement>(null),cleanup=useRef<(()=>Promise<void>)|null>(null),abort=useRef<AbortController|null>(null);
  async function close(){abort.current?.abort();setBusy(true);await cleanup.current?.();cleanup.current=null;setOpen(false);setBusy(false);}
  useEffect(()=>{if(!open||!ref.current)return;let disposed=false;const controller=new AbortController();abort.current=controller;const c=getMatrixClient();if(!c)return;const frame=ref.current;void import('@/lib/conference').then(m=>m.mountConference(c,roomId,frame,()=>void close(),controller.signal)).then(stop=>{if(disposed)void stop();else cleanup.current=stop;}).catch(e=>{if(!disposed)setError(e.message);});const off=onMatrixUpdate(()=>{if(getMatrixClient()!==c)void close();});return()=>{disposed=true;controller.abort();off();void cleanup.current?.();cleanup.current=null;};},[open,roomId]);
  return <><button className="icon-button" aria-label="Join conference" title="Join conference" disabled={disabled} onClick={()=>{const call=callSnapshot().call;if(call&&call.state!=='ended'){toast.error('Finish the direct call first.');return;}setError('');setOpen(true);}}><Video size={18}/></button>{open&&<section className="conference-panel" aria-label="Conference"><header><strong>Tavern conference</strong><button disabled={busy} className="icon-button" aria-label="Leave conference" onClick={()=>void close()}><X /></button></header>{error?<p className="connect-error" role="alert">{error}</p>:<p>Encrypted group media · powered by your self-hosted MatrixRTC services</p>}<iframe ref={ref} title="Tavern encrypted conference" allow="camera; microphone; display-capture; autoplay; fullscreen" referrerPolicy="no-referrer"/></section>}</>;
}
