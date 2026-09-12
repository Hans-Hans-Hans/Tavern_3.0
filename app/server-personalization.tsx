import {useEffect,useRef,useState,type ReactNode} from 'react';
import {getMatrixClient,onMatrixUpdate} from '@/lib/matrix';
import {accountArtworkOwner} from '@/lib/api';
import {readAppearance} from '@/lib/appearance';
import {personalColors,readPersonalServers,savePersonalServer,type PersonalColor} from '@/lib/server-personalization';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {ExperienceError} from './experience-error';
function usePersonalServers(){const[,tick]=useState(0);useEffect(()=>onMatrixUpdate(()=>tick(value=>value+1)),[]);return readPersonalServers();}
export function PersonalServerMark({serverId,children}:{serverId:string;children:ReactNode}){const color=usePersonalServers()[serverId];return <div className="personal-server-mark">{color&&<span aria-hidden="true" className="personal-server-color" style={{background:personalColors[color],filter:`saturate(${readAppearance().saturation})`}}/>}{children}</div>;}
export function PersonalServerDialog({server,onClose}:{server:{id:string;name:string};onClose:()=>void}){
 const colors=usePersonalServers(),[error,setError]=useState<unknown>(null),[busy,setBusy]=useState(false),lock=useRef(false),client=getMatrixClient(),owner=accountArtworkOwner(),generation=useRef(0);
 useEffect(()=>{generation.current++;return()=>{generation.current++;};},[client,owner,server.id]);
 async function save(color:PersonalColor|''){if(lock.current)return;lock.current=true;const revision=generation.current,current=()=>generation.current===revision&&client===getMatrixClient()&&owner===accountArtworkOwner();setBusy(true);setError(null);try{await savePersonalServer(server.id,color);if(current())onClose();}catch(error){if(current())setError(error);}finally{if(current()){lock.current=false;setBusy(false);}}}
 return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>Your color for {server.name}</DialogTitle><DialogDescription>Add a quiet color marker beside this server in your navigation. Only you see it; it syncs with your account and follows your color saturation setting.</DialogDescription></DialogHeader><div className="home-actions"><button className="secondary-button" aria-pressed={!colors[server.id]} disabled={busy} onClick={()=>void save('')}>Use default</button>{Object.entries(personalColors).map(([id,color])=><button key={id} className="secondary-button" aria-pressed={colors[server.id]===id} disabled={busy} onClick={()=>void save(id as PersonalColor)}><span aria-hidden="true" style={{background:color,width:16,height:16,borderRadius:'50%',filter:`saturate(${readAppearance().saturation})`}}/>{id[0].toUpperCase()+id.slice(1)}</button>)}</div><ExperienceError error={error}/></DialogContent></Dialog>;
}
