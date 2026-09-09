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
  const client = createClient({baseUrl:location.origin,userId:user,deviceId:'NEW',fetchFn:async()=>new Response(JSON.stringify({errcode:'M_NOT_FOUND'}),{status:404,headers:{'Content-Type':'application/json'}})});
  await client.initRustCrypto({cryptoDatabasePrefix:cryptoStorePrefix(user,'NEW')});
  const event = new MatrixEvent(old.wire);
  await client.decryptEventIfNeeded(event);
  let current = true;
  return {
    client, event, old, other, seed,
    repair:()=>recoverLocalHistory(client,()=>current),
    changeOwner:()=>{current=false;},
    decryptOther:async()=>{const value=new MatrixEvent(other.wire);await client.decryptEventIfNeeded(value);return value.isDecryptionFailure();},
    inspectOld:async()=>{const machine=await wasm.OlmMachine.initialize(new wasm.UserId(user),new wasm.DeviceId('OLD'),cryptoStorePrefix(user,'OLD'));const keys=JSON.parse(await machine.exportRoomKeys(()=>true));const fingerprint=machine.identityKeys.ed25519.toBase64();machine.close();return {keys:keys.length,fingerprint};},
    holdOld:async()=>{let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);const done=navigator.locks.request(cryptoStoreLock(user,'OLD'),async()=>{entered();await gate;});await started;return async()=>{release();await done;};},
  };
}
