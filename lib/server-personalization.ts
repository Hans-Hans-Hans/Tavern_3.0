import {getMatrixClient,mutateMatrixAccountData} from './matrix';
import {accountArtworkOwner} from './api';
export const serverPersonalizationKey='io.tavern.personal_servers';
export const personalColors={gold:'#be985c',blue:'#638ead',purple:'#a27cb0',green:'#73a38b',rose:'#c78296'};
export type PersonalColor=keyof typeof personalColors;
export function normalizePersonalServers(raw:unknown):Record<string,PersonalColor>{
 const values=raw&&typeof raw==='object'?(raw as any).colors:{};
 return Object.fromEntries(Object.entries(values&&typeof values==='object'?values:{}).slice(0,200).filter(([id,color])=>/^![^\s/\\?#]{1,254}$/.test(id)&&typeof color==='string'&&Object.hasOwn(personalColors,color))) as Record<string,PersonalColor>;
}
export function readPersonalServers(){return normalizePersonalServers(getMatrixClient()?.getAccountData(serverPersonalizationKey as any)?.getContent());}
export async function savePersonalServer(serverId:string,color:PersonalColor|''){
 const client=getMatrixClient(),owner=accountArtworkOwner(),room=client?.getRoom(serverId);
 if(!room?.isSpaceRoom()||room.getMyMembership()!=='join')throw new Error('Join this server before changing its personal appearance.');
 if(color&&!Object.hasOwn(personalColors,color))throw new Error('Choose one of the available colors.');
 const check=()=>{if(!client||getMatrixClient()!==client||owner!==accountArtworkOwner()||room.getMyMembership()!=='join')throw new Error('Your account or server membership changed.');};
 await mutateMatrixAccountData(client!,serverPersonalizationKey,raw=>{const colors=normalizePersonalServers(raw);delete colors[serverId];if(color)colors[serverId]=color;return {version:1,colors:Object.fromEntries(Object.entries(colors).slice(-200))};},check);
}
