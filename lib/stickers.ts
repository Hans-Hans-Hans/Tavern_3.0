import {getMatrixClient} from './matrix';
import {accountArtworkOwner} from './api';
import {cropProfileImage,uploadProfileImage} from './community';
import {effectiveRolePermissions,readRolePolicy} from './roles';
import {parseStickerPack,stickerEvent,type StickerPack} from './sticker-model';
export function readStickerPacks(serverId:string):StickerPack[]{
 const room=getMatrixClient()?.getRoom(serverId);
 if(!room?.isSpaceRoom()||room.getMyMembership()!=='join')return [];
 return room.currentState.getStateEvents(stickerEvent).flatMap(event=>{const value=parseStickerPack(event.getStateKey()||'',event.getContent());return value?[value]:[];}).slice(0,20);
}
export function canManageStickers(serverId:string){
 const client=getMatrixClient(),room=client?.getRoom(serverId),user=client?.getUserId(),policy=readRolePolicy(serverId);
 return !!(user&&room?.isSpaceRoom()&&room.getMyMembership()==='join'&&room.currentState.maySendStateEvent(stickerEvent,user)&&(!policy||effectiveRolePermissions(policy,user).has('manage_server')));
}
export async function saveStickerPack(serverId:string,pack:StickerPack,previous:StickerPack|null,deleted=false){
 const client=getMatrixClient(),account=accountArtworkOwner(),actor=client?.getUserId(),device=client?.getDeviceId();
 const check=()=>{if(!client||getMatrixClient()!==client||accountArtworkOwner()!==account||client.getUserId()!==actor||client.getDeviceId()!==device||!canManageStickers(serverId))throw new Error('Your account or server permissions changed. Reopen sticker settings.');};
 check();const value=parseStickerPack(pack.id,{version:1,...pack});if(!value)throw new Error('Use a pack name and valid image stickers with descriptive text.');
 const state=await client!.roomState(serverId);check();
 const current=state.find(event=>event.type===stickerEvent&&event.state_key===pack.id),saved=current?parseStickerPack(pack.id,current.content):null;
 if(JSON.stringify(saved)!==JSON.stringify(previous))throw new Error('This sticker pack changed. Reload it before saving.');
 if(!saved&&!deleted&&state.filter(event=>event.type===stickerEvent&&parseStickerPack(event.state_key,event.content)).length>=20)throw new Error('Each server supports up to 20 sticker packs.');
 await client!.sendStateEvent(serverId,stickerEvent as any,{version:1,...(deleted?{deleted:true}:{name:value.name,stickers:value.stickers}),'io.tavern.previous_event':current?.event_id??null},pack.id);check();
}
export async function addSticker(serverId:string,pack:StickerPack,file:File,name:string,alt:string){
 const client=getMatrixClient(),account=accountArtworkOwner();
 if(!canManageStickers(serverId))throw new Error('Server management permission is required.');
 if(pack.stickers.length>=50||!name.trim()||name.length>60||!alt.trim()||alt.length>160)throw new Error('Use a name and description. Each pack supports up to 50 stickers.');
 if(!['image/png','image/jpeg','image/webp','image/gif','image/avif'].includes(file.type)||file.size>10*1024*1024)throw new Error('Choose an image up to 10 MiB. Static square stickers are generated from uploaded artwork.');
 const image=await cropProfileImage(file);
 if(getMatrixClient()!==client||accountArtworkOwner()!==account||!canManageStickers(serverId))throw new Error('Your account or permissions changed.');
 const url=await uploadProfileImage(image);
 if(getMatrixClient()!==client||accountArtworkOwner()!==account)throw new Error('Your account changed.');
 await saveStickerPack(serverId,{...pack,stickers:[...pack.stickers,{id:crypto.randomUUID(),name:name.trim(),alt:alt.trim(),url}]},pack);
}
