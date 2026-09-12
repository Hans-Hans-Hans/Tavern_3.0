export const stickerEvent='io.tavern.stickers';
export type Sticker={id:string;name:string;alt:string;url:string};
export type StickerPack={id:string;name:string;stickers:Sticker[]};
const mxc=(value:unknown):value is string=>typeof value==='string'&&value.length<=1024&&/^mxc:\/\/[^\s/?#\x00-\x1f]+\/[a-zA-Z0-9_-]+$/.test(value);
const label=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
export function parseSticker(value:unknown):Sticker|null{
 const item=value as any;
 return item&&label(item.name,60)&&label(item.alt,160)&&mxc(item.url)&&typeof item.id==='string'&&/^[\w-]{1,80}$/.test(item.id)?{id:item.id,name:item.name,alt:item.alt,url:item.url}:null;
}
export function parseStickerPack(id:string,value:unknown):StickerPack|null{
 const raw=value as any;
 if(!/^[\w-]{1,80}$/.test(id)||raw?.version!==1||raw.deleted||!label(raw.name,60)||!Array.isArray(raw.stickers)||raw.stickers.length>50)return null;
 const stickers=raw.stickers.map(parseSticker);
 if(stickers.some((value:Sticker|null)=>!value)||new Set(stickers.map((value:Sticker)=>value.id)).size!==stickers.length)return null;
 return {id,name:raw.name,stickers};
}
