import React from 'react';
import { createRoot } from 'react-dom/client';
import { mountFixture as mountDrafts } from './message-drafts';
import { OutboxPanel } from '../../../app/outbox-panel';
import { enqueueOutbox, initializeOutbox, readOutbox, resetOutbox } from '../../../lib/outbox';
import { accountArtworkOwner } from '../../../lib/api';
import { attachmentTransaction } from '../../../lib/outbox-attachments';
import { encryptAttachment } from 'matrix-encrypt-attachment';

export async function mountFixture(){
  mountDrafts();const w=window as any, original=w.matrixBoundary,uploaded=new Map<string,any>();w.deliveries=[];w.failDelivery=true;w.failUpload=false;
  async function upload(file:File,roomId:string){
    if(w.failUpload)throw new Error('Fixture upload unavailable');
    const encrypted=await encryptAttachment(await file.arrayBuffer()),id=crypto.randomUUID(),url='mxc://local/'+id;
    const descriptor={id,roomId,name:file.name,size:file.size,type:file.type,url,file:{...encrypted.info,url},info:{}};uploaded.set(id,descriptor);return descriptor;
  }
  w.matrixBoundary=(name:string,args:any[])=>{
    if(name==='uploadMatrixFile')return upload(args[0],args[1]);
    if(name==='snapshotMatrixAttachments')return args[0].map((id:string,index:number)=>{const descriptor=uploaded.get(id);return {id,name:descriptor.name,size:descriptor.size,type:descriptor.type,descriptor,transactionId:attachmentTransaction(args[3],index)};});
    if(name==='discardMatrixFile'){uploaded.delete(args[0]);return;}
    return original(name,args);
  };
  async function open(){const owner=accountArtworkOwner();await initializeOutbox(w.client,async(item:any,checkpoint:any)=>{
    await checkpoint.prepare({msgtype:'m.text',body:item.body,'m.mentions':{user_ids:[]}},true);
    for(const file of item.attachments||[]){if(file.eventId)continue;const descriptor=file.descriptor||await checkpoint.upload(file.id);w.deliveries.push({name:file.name,transaction:file.transactionId,descriptor});if(w.deferDelivery)await new Promise(resolve=>w.releaseDelivery=resolve);if(w.failDelivery)throw new Error('Fixture send unavailable');await checkpoint.attachment(file.id,file.transactionId,'$ack-'+file.id);}
    if(item.body&&!item.bodyEventId)await checkpoint.body('$body-'+item.id);
  },{current:()=>accountArtworkOwner()===owner,upload:(file,item)=>upload(file,item.roomId)});}
  await open();w.enqueueOutbox=enqueueOutbox;w.readOutbox=readOutbox;w.reopenOutbox=async()=>{resetOutbox();await open();};
  const panel=document.createElement('div');panel.id='outbox-fixture';Object.assign(panel.style,{position:'fixed',zIndex:'500',top:'70px',right:'12px',width:'390px',maxHeight:'380px',overflow:'auto',background:'white',padding:'12px'});document.body.append(panel);createRoot(panel).render(<OutboxPanel onOpen={()=>{}}/>);
  w.outboxReady=true;
}
