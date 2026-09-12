import { useEffect, useRef, useState } from 'react';
import { matrixApi, getMatrixClient } from '@/lib/matrix';
import { accountArtworkOwner } from '@/lib/api';
import { readInstanceConfig } from '@/lib/instance';
import { channelKinds } from '@/lib/channel-policy';
import { channelTemplates, createTypedChannel, finishChannelCreation, type ChannelCreationResult } from '@/lib/channel-creation';
import { serverTemplates } from '@/lib/server-templates';
import { terminology, type Naming } from '@/lib/terminology';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ExperienceError } from './experience-error';
import './experience.css';
export function ServerDialog({ open, naming, onClose, onCreated }: { open: boolean; naming: Naming; onClose: () => void; onCreated: (id: string, roomId?: string) => Promise<void> }) {
  const [name,setName]=useState(''),[description,setDescription]=useState(''),[notificationMode,setNotificationMode]=useState('mentions'),[welcome,setWelcome]=useState(''),[welcomeEnabled,setWelcomeEnabled]=useState(true);
  const [template,setTemplate]=useState('blank'),[selected,setSelected]=useState<string[]>([]),[policyEnabled,setPolicyEnabled]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),[progress,setProgress]=useState(''),[created,setCreated]=useState(''),[uncertain,setUncertain]=useState(false);
  const lock=useRef(false),live=useRef(true),owner=useRef({client:getMatrixClient(),account:accountArtworkOwner()}),receipts=useRef(new Map<string,ChannelCreationResult>()),serverId=useRef('');
  const current=()=>live.current&&getMatrixClient()===owner.current.client&&accountArtworkOwner()===owner.current.account;
  useEffect(()=>{live.current=true;void readInstanceConfig().then(value=>{if(current())setPolicyEnabled(value.serverRolePolicy===true);});return()=>{live.current=false;};},[]);
  const terms=terminology(naming), layout=serverTemplates[template];
  async function create() {
    if(lock.current||uncertain||!current())return;lock.current=true;setBusy(true);setError(null);
    try {
      if(!serverId.current){
        setProgress('Creating your server…');
        try {const result=await matrixApi('createServer',{name,description,notificationMode,welcome,welcomeEnabled});if(!current())return;serverId.current=result.id;setCreated(result.id);}
        catch(error){if(current())setUncertain(true);throw error;}
      }
      for(const channel of layout.channels.filter(value=>selected.includes(value.name))){
        if(!current())return;setProgress('Setting up #'+channel.name+'…');
        let receipt=receipts.current.get(channel.name);
        try {receipt=receipt?await finishChannelCreation(receipt):await createTypedChannel({...channel,serverId:serverId.current,categoryId:'',members:[],slowModeSeconds:0,icon:channelTemplates[channel.kind].icon});}
        catch(error){if(current()&&/creation was not confirmed|valid channel ID/.test((error as Error).message))setUncertain(true);throw error;}
        if(!current())return;receipts.current.set(channel.name,receipt);
        if(receipt.errors.length)throw new Error(receipt.errors.join(' '));
      }
      await onCreated(serverId.current,[...receipts.current.values()][0]?.roomId);if(current())onClose();
    } catch(error){if(current())setError(error);} finally{lock.current=false;if(current()){setBusy(false);setProgress('');}}
  }
  return <Dialog open={open} onOpenChange={value=>{if(!value&&!busy)onClose();}}><DialogContent className="tavern-dialog settings-dialog"><DialogHeader><DialogTitle>{created?'Finish your server':`Create a ${terms.server}`}</DialogTitle><DialogDescription>Choose a starting layout, then keep only the channels you want. Everything can be edited afterward.</DialogDescription></DialogHeader>
    <form className="dialog-form" onSubmit={event=>{event.preventDefault();void create();}}><fieldset disabled={busy||!!created||uncertain}>
      <label>Name<input value={name} onChange={event=>setName(event.target.value)} required maxLength={60}/></label><label>Description<input value={description} onChange={event=>setDescription(event.target.value)} maxLength={200}/></label>
      <label>Starting layout<select value={template} onChange={event=>{const id=event.target.value;setTemplate(id);setSelected(serverTemplates[id].channels.filter(channel=>policyEnabled||channel.kind==='text').map(channel=>channel.name));}}>{Object.entries(serverTemplates).map(([id,value])=><option key={id} value={id}>{value.name}</option>)}</select></label><p>{layout.description}</p>
      {!!layout.channels.length&&<fieldset><legend>Channels to include</legend>{layout.channels.map(channel=><label className="check-label" key={channel.name}><input type="checkbox" checked={selected.includes(channel.name)} disabled={!policyEnabled&&channel.kind!=='text'} onChange={event=>setSelected(current=>event.target.checked?[...current,channel.name]:current.filter(name=>name!==channel.name))}/><span><strong>{channel.name}</strong> · {channelKinds[channel.kind]}<small style={{display:'block'}}>{channel.description}</small></span></label>)}</fieldset>}
      <details><summary>Welcome and notifications</summary><label>Default notifications<select value={notificationMode} onChange={event=>setNotificationMode(event.target.value)}><option value="mentions">Mentions only</option><option value="all">All messages</option><option value="nothing">Nothing</option><option value="inherit">Use member preferences</option></select></label><label className="check-label"><input type="checkbox" checked={welcomeEnabled} onChange={event=>setWelcomeEnabled(event.target.checked)}/>Show a welcome screen to new members</label>{welcomeEnabled&&<label>Welcome message<textarea value={welcome} onChange={event=>setWelcome(event.target.value)} maxLength={2000}/></label>}</details>
      <p className="login-help">The server and its channels start invite-only. Invite people to the conversations they should join. Voice channels open their participant view; microphones stay off until a member joins a call.</p>
    </fieldset>
    <ExperienceError error={error} draft={created?'Your server and completed channels are kept. Retry finishes the remaining setup.':'Your form entries are kept.'}/>
    {uncertain&&<p role="status">Creation could not be confirmed. Check All channels and your server list before creating another copy. Automatic creation retries are paused.</p>}
    {!!receipts.current.size&&<ul aria-label="Created channels">{[...receipts.current.entries()].map(([name,result])=><li key={name}>#{name}: {result.errors.length?'Needs remaining setup':'Ready'}</li>)}</ul>}
    <div className="product-actions"><button className="primary-button" disabled={busy||!name.trim()||uncertain}>{busy?progress:created?'Finish remaining setup':`Create ${terms.server}`}</button>{created&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void onCreated(created,[...receipts.current.values()][0]?.roomId).then(()=>{if(current())onClose();}).catch(setError)}>Open created server</button>}</div>
    </form></DialogContent></Dialog>;
}
