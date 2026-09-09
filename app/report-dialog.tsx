import { useState } from 'react';
import { requestApi } from '@/lib/api';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
export type ReportTarget={kind:'message'|'user'|'file'|'server';roomId?:string;eventId?:string;targetId?:string};
export function ReportDialog({target,onClose}:{target:ReportTarget|null;onClose:()=>void}){
  const[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <Dialog open={!!target} onOpenChange={open=>{if(!open&&!busy){setReason('');onClose();}}}><DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>Report {target?.kind}</DialogTitle><DialogDescription>Explain the concern to your instance moderators. Only the text you enter and the referenced IDs are submitted; encrypted message contents are not automatically included.</DialogDescription></DialogHeader><form className="dialog-form" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await requestApi('/reports',{...target,reason});setReason('');onClose();toast.success('Report submitted');}catch(e:any){setError(e.message);}finally{setBusy(false);}}}><label>Reason<textarea autoFocus required minLength={5} maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></label>{error&&<p className="connect-error" role="alert">{error}</p>}<button className="primary-button" disabled={busy||reason.trim().length<5}>Submit report</button></form></DialogContent></Dialog>;
}
