import React from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { ReactionBar } from '../../../app/reaction-bar';
import { createImagePreview } from '../../../lib/media-processing';
export function mountFixture() {
  const w=window as any;w.calls=0;w.profiles=[];w.fixtureClient={getUserId:()=> '@self:local',getRoom:()=>({getMember:(id:string)=>({name:id==='@peer:local'?'Peer':'You'})})};
  w.previewImage=async()=>{const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=800;canvas.getContext('2d')!.fillRect(0,0,1200,800);const blob=await new Promise<Blob>(resolve=>canvas.toBlob(result=>resolve(result!),'image/png'));const file=new File([blob],'original.png',{type:'image/png'});const originalSize=file.size;const preview=await createImagePreview(file);const bitmap=await createImageBitmap(preview!.blob);const result={width:bitmap.width,height:bitmap.height,sourceWidth:preview?.sourceWidth,sourceHeight:preview?.sourceHeight,mime:preview?.blob.type,size:preview?.blob.size,originalUnchanged:file.size===originalSize};bitmap.close();return result;};
  w.svgPreview=()=>createImagePreview(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'],'image.svg',{type:'image/svg+xml'}));
  createRoot(document.getElementById('root')!).render(<><ReactionBar roomId="!room:local" eventId="$message" reactions={[{emoji:'👍',count:1,mine:0,users:['@peer:local']}]} canReact onProfile={id=>w.profiles.push(id)}/><Toaster/></>);
}
