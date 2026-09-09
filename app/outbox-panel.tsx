import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cancelOutbox, editOutbox, enqueueOutbox, outboxOwner, readOutbox, retryOutbox, watchOutbox, type OutboxItem } from '@/lib/outbox';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { Field } from './auth-gateway';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
const localTime = (n: number) => new Date(n - new Date(n).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const observeOwner=(listener:()=>void)=>{const off=watchOutbox(listener),matrixOff=onMatrixUpdate(listener);return()=>{off();matrixOff();};};
const useOwner = () => useSyncExternalStore(observeOwner, outboxOwner, () => null);
export function ScheduleMessage({ roomId, parent, serverId, body, onScheduled, disabled }: { roomId: string; parent?: string; serverId?: string; body: string; onScheduled: () => void; disabled?: boolean }) {
  const owner=useOwner(), identity=useRef({owner,roomId,parent,serverId,body}),mounted=useRef(true);
  if(identity.current.owner!==owner||identity.current.roomId!==roomId||identity.current.parent!==parent||identity.current.serverId!==serverId||identity.current.body!==body)identity.current={owner,roomId,parent,serverId,body};
  const scope=identity.current,[opened,setOpened]=useState<typeof scope|null>(null),[due,setDue]=useState(localTime(Date.now()+3600000)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const current=()=>mounted.current&&identity.current===scope&&outboxOwner()===owner;
  useEffect(()=>{setOpened(null);setBusy(false);setError('');},[scope]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  return <><button className="icon-button" aria-label="Schedule this message" disabled={disabled||!body.trim()||!owner} onClick={()=>{if(current())setOpened(scope);}}>◷</button>
    <Dialog open={opened===scope} onOpenChange={value=>{if(!value&&!busy)setOpened(null);}}><DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>Schedule message</DialogTitle><DialogDescription>The encrypted outbox delivers while Tavern is open and connected on this device. If closed, it sends when you next open this device's session.</DialogDescription></DialogHeader>
      <form className="dialog-form" onSubmit={async e=>{e.preventDefault();if(!owner||!current()||busy)return;setBusy(true);setError('');
        try{await enqueueOutbox({kind:'scheduled',roomId,parent,serverId,body,due:new Date(due).getTime()});if(!current())return;onScheduled();setOpened(null);toast.success('Message scheduled on this device');}
        catch(error:any){if(current())setError(error.message);}finally{if(current())setBusy(false);}}}>
        <Field label="Send at (local time)"><input type="datetime-local" required min={localTime(Date.now())} value={due} onChange={e=>setDue(e.target.value)}/></Field><p>{body.slice(0,300)}</p>
        {error&&<p role="alert" className="connect-error">{error}</p>}<button className="primary-button" disabled={busy}>Schedule</button>
      </form></DialogContent></Dialog></>;
}
export function ReminderDialog({ roomId, eventId, onClose }: { roomId: string; eventId: string; onClose: () => void }) {
  const owner=useOwner(),identity=useRef({owner,roomId,eventId}),mounted=useRef(true);
  if(identity.current.owner!==owner||identity.current.roomId!==roomId||identity.current.eventId!==eventId)identity.current={owner,roomId,eventId};
  const scope=identity.current,[due,setDue]=useState(localTime(Date.now()+1200000)),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const current=()=>mounted.current&&identity.current===scope&&outboxOwner()===owner;
  useEffect(()=>{setBusy(false);setError('');setDue(localTime(Date.now()+1200000));},[scope]);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  return <Dialog open onOpenChange={value=>{if(!value&&!busy&&current())onClose();}}><DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>Remind me about this message</DialogTitle><DialogDescription>Reminders appear while this device's Tavern session is open. Missed reminders appear when you return.</DialogDescription></DialogHeader>
    <form className="dialog-form" onSubmit={async e=>{e.preventDefault();if(!owner||!current()||busy)return;setBusy(true);setError('');
      try{await enqueueOutbox({kind:'reminder',roomId,eventId,body:'',due:new Date(due).getTime()});if(current()){onClose();toast.success('Reminder saved');}}catch(error:any){if(current())setError(error.message);}finally{if(current())setBusy(false);}}}>
      <div className="product-actions">{[[1200000,'20 minutes'],[3600000,'1 hour'],[86400000,'Tomorrow'],[604800000,'Next week']].map(([delay,label])=><button className="secondary-button" type="button" key={delay} onClick={()=>setDue(localTime(Date.now()+Number(delay)))}>{label}</button>)}</div>
      <Field label="Remind me at"><input type="datetime-local" required min={localTime(Date.now())} value={due} onChange={e=>setDue(e.target.value)}/></Field>
      {error&&<p role="alert" className="connect-error">{error}</p>}<button className="primary-button" disabled={busy||!owner}>Save reminder</button>
    </form></DialogContent></Dialog>;
}
export function OutboxPanel({ onOpen }: { onOpen: (roomId: string, eventId?: string) => void }) {
  const owner = useOwner(), [data, setData] = useState<{ owner: object | null; items: OutboxItem[]; error: string }>({owner:null,items:[],error:''});
  const [editing, setEditing] = useState<{owner:object;item:OutboxItem}|null>(null), [busyOwner, setBusyOwner] = useState<object|null>(null);
  const lifecycle=useRef(0), request=useRef(0), items=data.owner===owner?data.items:[], error=data.owner===owner?data.error:'', busy=!!owner&&busyOwner===owner;
  useEffect(() => {
    const view=++lifecycle.current; setEditing(null);setBusyOwner(null);
    const refresh=()=>{const serial=++request.current;if(!owner){setData({owner,items:[],error:'Your encrypted outbox is still opening.'});return;}
      void readOutbox().then(items=>{if(lifecycle.current===view&&request.current===serial&&outboxOwner()===owner)setData({owner,items,error:''});})
      .catch(error=>{if(lifecycle.current===view&&request.current===serial&&outboxOwner()===owner)setData(old=>({owner,items:old.owner===owner?old.items:[],error:error.message}));});};
    refresh();const off=watchOutbox(refresh);return()=>{lifecycle.current++;request.current++;off();};
  },[owner]);
  async function run(captured:object,fn:()=>Promise<unknown>){
    if(outboxOwner()!==captured||busy)return false;const view=lifecycle.current;setBusyOwner(captured);
    try{await fn();return lifecycle.current===view&&outboxOwner()===captured;}
    catch(error:any){if(lifecycle.current===view&&outboxOwner()===captured)setData(old=>({...old,owner:captured,error:error.message}));return false;}
    finally{if(lifecycle.current===view&&outboxOwner()===captured)setBusyOwner(null);}
  }
  const edit=editing?.owner===owner?editing:null;
  return <section className="product-section"><h3>Outbox & reminders</h3><p>This device's encrypted outbox sends when Tavern is open and connected. Saved unsent drafts wait for your explicit retry. Up to 100 items and 100 MiB of pending file copies stay on this device.</p><p>Cancelling removes the local pending item. It does not remove files already uploaded or messages already received by the homeserver.</p>
    {error&&<p role="alert" className="connect-error">{error}</p>}
    {owner&&items.map(item=><article className="product-section" key={item.id}>
      <h3>{item.kind==='reminder'?'Reminder':item.kind==='draft'?'Saved unsent draft':item.kind==='queued'?'Queued message':'Scheduled message'} · {getMatrixClient()?.getRoom(item.roomId)?.name||item.roomId}</h3>
      <small>{new Date(item.due).toLocaleString()}</small>{item.body&&<p>{item.body}</p>}
      {!!item.attachments?.length&&<ul aria-label="Attachment delivery status">{item.attachments.map(file=><li key={file.id}>{file.name} — {file.eventId?'Acknowledged by homeserver':file.descriptor?'Uploaded; message not acknowledged':'Saved on this device; upload pending'}</li>)}</ul>}
      {item.bodyEventId&&<p role="status">Message text acknowledged by homeserver.</p>}{item.error&&<p role="status">{item.error}</p>}
      {!!item.attempts&&<p>Delivery attempts: {item.attempts}. Retry keeps the original content and transactions. An unconfirmed request may already have reached the homeserver.</p>}
      <div className="product-actions"><button className="secondary-button" onClick={()=>{if(outboxOwner()===owner)onOpen(item.roomId,item.eventId);}}>Open conversation</button>
        {!item.attempts&&!item.preparedContent&&<button className="secondary-button" disabled={busy} onClick={()=>{if(outboxOwner()===owner)setEditing({owner,item:structuredClone(item)});}}>Edit</button>}
        {item.kind!=='reminder'&&(item.error||item.kind==='draft')&&<button className="secondary-button" disabled={busy} onClick={()=>void run(owner,()=>retryOutbox(item.id))}>Retry delivery</button>}
        <button className="secondary-button" disabled={busy} onClick={()=>void run(owner,()=>cancelOutbox(item.id))}>{item.kind==='reminder'?'Dismiss reminder':'Cancel delivery'}</button>
      </div></article>)}
    {!items.length&&!error&&<p>No pending messages or reminders.</p>}
    <Dialog open={!!edit} onOpenChange={value=>{if(!value&&!busy)setEditing(null);}}><DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>Edit pending item</DialogTitle><DialogDescription>Changes apply only before delivery has been attempted.</DialogDescription></DialogHeader>
      {edit&&<form className="dialog-form" onSubmit={async e=>{e.preventDefault();if(await run(edit.owner,()=>editOutbox(edit.item.id,edit.item.body,edit.item.due)))setEditing(null);}}>
        <Field label="Time"><input type="datetime-local" required value={localTime(edit.item.due)} onChange={e=>setEditing({...edit,item:{...edit.item,due:new Date(e.target.value).getTime()}})}/></Field>
        {edit.item.kind!=='reminder'&&<Field label="Message"><textarea required={!edit.item.attachments?.length} maxLength={8000} value={edit.item.body} onChange={e=>setEditing({...edit,item:{...edit.item,body:e.target.value}})}/></Field>}
        <button className="primary-button" disabled={busy}>Save changes</button></form>}
    </DialogContent></Dialog>
  </section>;
}
