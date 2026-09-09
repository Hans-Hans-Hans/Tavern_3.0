import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { deferredPanel } from '@/app/deferred-panel';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import '@/app/globals.css';

let attempts=0;
const OptionalPanel=deferredPanel('Optional settings',async()=>{
  attempts++;(window as any).attempts=attempts;
  if(attempts===1)throw new Error('Synthetic import failure');
  return{default:()=> <label>Optional value<input defaultValue='Available again'/></label>};
});
function Fixture(){
  const[open,setOpen]=useState(false),[draft,setDraft]=useState('');
  return <><label>Conversation draft<input value={draft} onChange={event=>setDraft(event.target.value)}/></label><button onClick={()=>setOpen(true)}>Open optional settings</button><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Settings</DialogTitle><DialogDescription>Update optional settings.</DialogDescription></DialogHeader><OptionalPanel/></DialogContent></Dialog></>;
}
export function mountFixture(){createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);}
