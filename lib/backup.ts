import type { MatrixClient } from 'matrix-js-sdk';
import { Method, ClientPrefix } from 'matrix-js-sdk/lib/http-api';
import { decodeBase64 } from 'matrix-js-sdk/lib/base64';
type BackupInfo={version:string;algorithm:string;auth_data:{public_key:string};count:number;etag:string};
export async function discoverBackup(c:MatrixClient):Promise<BackupInfo|null>{
  try{return await c.http.authedRequest(Method.Get,'/room_keys/version',undefined,undefined,{prefix:ClientPrefix.V3});}
  catch(e){if((e as any)?.errcode==='M_NOT_FOUND')return null;throw e;}
}
/** Create with POST, never SDK resetKeyBackup (which deletes all older versions).
 * An encrypted per-device pending secret survives an uncertain server response.
 */
export async function createOrResumeBackup(c:MatrixClient,isCurrent:()=>boolean=()=>true){
  const check=()=>{if(!isCurrent())throw new Error('Your signed-in session changed. Retry recovery from the current session.');};
  check();
  const crypto=c.getCrypto()!;
  const {BackupDecryptionKey,initAsync}=await import('@matrix-org/matrix-sdk-crypto-wasm');await initAsync();check();
  const pendingName=`io.tavern.backup.pending.${c.getDeviceId()}`;
  const existingPending=await c.secretStorage.get(pendingName);
  check();
  const current=await discoverBackup(c);
  check();
  const canonical=await c.secretStorage.get('m.megolm_backup.v1');
  check();
  const source=existingPending||canonical;
  const key=source?BackupDecryptionKey.fromBase64(source):BackupDecryptionKey.createRandomKey();
  const pub=key.megolmV1PublicKey,secret=key.toBase64(),bytes=decodeBase64(secret);
  try{
    let version:string;
    if(current){
      if(current.algorithm!==pub.algorithm||current.auth_data.public_key!==pub.publicKeyBase64)throw new Error('An existing backup uses a different key. Recover it on the device that created it. Existing backup versions were preserved.');
      version=current.version;
    }else{
      await c.secretStorage.store(pendingName,secret);
      check();
      // Recheck immediately before POST; errors must not be interpreted as absence.
      if(await discoverBackup(c))throw new Error('Another device created a backup. Recover that backup before continuing.');
      check();
      const result=await c.http.authedRequest<{version:string}>(Method.Post,'/room_keys/version',undefined,{algorithm:pub.algorithm,auth_data:{public_key:pub.publicKeyBase64}},{prefix:ClientPrefix.V3});
      check();
      version=result.version;
    }
    if(typeof version!=='string'||!version)throw new Error('Homeserver returned an invalid backup version.');
    await crypto.storeSessionBackupPrivateKey(bytes,version);
    check();
    const latest=await discoverBackup(c);
    check();
    if(latest?.version!==version||latest.auth_data.public_key!==pub.publicKeyBase64)throw new Error('Backup changed on another device. Your candidate key remains encrypted in secret storage; no backup versions were deleted.');
    await c.secretStorage.store('m.megolm_backup.v1',secret);
    check();
    await crypto.checkKeyBackupAndEnable();
    check();
    if(await crypto.getActiveSessionBackupVersion()!==version)throw new Error('Backup was created but could not be enabled. Retry recovery with Finish interrupted setup.');
  }finally{bytes.fill(0);pub.free();key.free();}
}
