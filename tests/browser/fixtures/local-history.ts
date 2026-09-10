import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import { createClient, MatrixEvent } from 'matrix-js-sdk';
import { recoverLocalHistory, cryptoStorePrefix, cryptoStoreLock } from '../../../lib/local-history-recovery';
const user = '@history:local', room = '!old-history:local';
export async function fixture() {
  await wasm.initAsync();
  const seed = async (account = user, device = 'OLD', prefix = cryptoStorePrefix(account, device)) => {
    const machine = await wasm.OlmMachine.initialize(new wasm.UserId(account), new wasm.DeviceId(device), prefix);
    const fingerprint = machine.identityKeys.ed25519.toBase64();
    await machine.shareRoomKey(new wasm.RoomId(room), [], new wasm.EncryptionSettings());
    const content = JSON.parse(await machine.encryptRoomEvent(new wasm.RoomId(room), 'm.room.message', JSON.stringify({msgtype:'m.text',body:`Saved message from ${device}`})));
    machine.close();
    return {wire:{type:'m.room.encrypted',sender:account,event_id:`$${device}`,origin_server_ts:1,room_id:room,content},fingerprint};
  };
  const old = await seed();
  const other = await seed('@another:local', 'OTHER');
  // A misleading name must not grant another account's keys to this account.
  await seed('@another:local', 'ALIEN', cryptoStorePrefix(user, 'ALIEN'));
  let serverBackup: any = null, backupReads = 0, beforeBackup: ((count:number)=>void|Promise<void>) | null = null;
  const client = createClient({baseUrl:location.origin,userId:user,deviceId:'NEW',fetchFn:async(url, options)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/room_keys/version')) { backupReads++; await beforeBackup?.(backupReads); if(serverBackup)return new Response(JSON.stringify(serverBackup),{status:200,headers:{'Content-Type':'application/json'}}); }
    if(path.endsWith('/room_keys/keys')&&options?.method==='PUT')return new Response(JSON.stringify({etag:'fixture',count:1}),{status:200,headers:{'Content-Type':'application/json'}});
    return new Response(JSON.stringify({errcode:'M_NOT_FOUND'}),{status:404,headers:{'Content-Type':'application/json'}});
  }});
  await client.initRustCrypto({cryptoDatabasePrefix:cryptoStorePrefix(user,'NEW')});
  const event = new MatrixEvent(old.wire);
  await client.decryptEventIfNeeded(event);
  let current = true;
  return {
    client, event, old, other, seed,
    seedBackup:async(version='1')=>{
      const machine=await wasm.OlmMachine.initialize(new wasm.UserId(user),new wasm.DeviceId('OLD'),cryptoStorePrefix(user,'OLD'));
      const key=wasm.BackupDecryptionKey.createRandomKey(),pub=key.megolmV1PublicKey;
      try{await machine.saveBackupDecryptionKey(key,version);serverBackup={version,algorithm:pub.algorithm,auth_data:{public_key:pub.publicKeyBase64},count:0,etag:'fixture'};return serverBackup.auth_data.public_key;}
      finally{pub.free();key.free();machine.close();}
    },
    copyBackupTo:async(device:string)=>{
      const oldMachine=await wasm.OlmMachine.initialize(new wasm.UserId(user),new wasm.DeviceId('OLD'),cryptoStorePrefix(user,'OLD'));
      const bundle=await oldMachine.getBackupKeys(),key=bundle.decryptionKey;
      let next:wasm.OlmMachine|undefined;
      try{next=await wasm.OlmMachine.initialize(new wasm.UserId(user),new wasm.DeviceId(device),cryptoStorePrefix(user,device));await next.saveBackupDecryptionKey(key!,bundle.backupVersion!);}
      finally{next?.close();key?.free();bundle.free();oldMachine.close();}
    },
    backupReadCount:()=>backupReads,
    backupInfo:()=>structuredClone(serverBackup),
    setBackupInfo:(value:any)=>{serverBackup=value;},
    beforeBackup:(callback:(count:number)=>void|Promise<void>)=>{backupReads=0;beforeBackup=callback;},
    cachedBackupMatches:async()=>serverBackup?(await client.getCrypto()!.isKeyBackupTrusted(serverBackup)).matchesDecryptionKey:false,
    hasCachedBackup:async()=>{const key=await client.getCrypto()!.getSessionBackupPrivateKey();try{return !!key;}finally{key?.fill(0);}},
    seedCurrentBackup:async()=>{const key=wasm.BackupDecryptionKey.createRandomKey(),pub=key.megolmV1PublicKey,bytes=Uint8Array.from(atob(key.toBase64()),value=>value.charCodeAt(0));try{await client.getCrypto()!.storeSessionBackupPrivateKey(bytes,'previous');return pub.publicKeyBase64;}finally{bytes.fill(0);pub.free();key.free();}},
    cachedPublicKey:async()=>{const bytes=await client.getCrypto()!.getSessionBackupPrivateKey();if(!bytes)return null;const key=wasm.BackupDecryptionKey.fromBase64(btoa(String.fromCharCode(...bytes))),pub=key.megolmV1PublicKey;try{return pub.publicKeyBase64;}finally{bytes.fill(0);pub.free();key.free();}},
    repair:()=>recoverLocalHistory(client,()=>current),
    changeOwner:()=>{current=false;},
    decryptOther:async()=>{const value=new MatrixEvent(other.wire);await client.decryptEventIfNeeded(value);return value.isDecryptionFailure();},
    inspectOld:async()=>{const machine=await wasm.OlmMachine.initialize(new wasm.UserId(user),new wasm.DeviceId('OLD'),cryptoStorePrefix(user,'OLD'));const keys=JSON.parse(await machine.exportRoomKeys(()=>true));const fingerprint=machine.identityKeys.ed25519.toBase64();machine.close();return {keys:keys.length,fingerprint};},
    holdOld:async()=>{let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);const done=navigator.locks.request(cryptoStoreLock(user,'OLD'),async()=>{entered();await gate;});await started;return async()=>{release();await done;};},
  };
}
