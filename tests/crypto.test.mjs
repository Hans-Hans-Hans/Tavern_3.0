import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window={crypto:globalThis.crypto,btoa:globalThis.btoa,atob:globalThis.atob};
const { encryptAttachment, decryptAttachment }=await import('matrix-encrypt-attachment/lib/webcrypto.js');
import { initAsync, OlmMachine } from '@matrix-org/matrix-sdk-crypto-wasm';

test('Matrix attachment encryption roundtrips and rejects modified ciphertext',async()=>{
 const plain=new TextEncoder().encode('Harbor attachment integrity test').buffer;
 const encrypted=await encryptAttachment(plain);
 assert.notDeepEqual(new Uint8Array(encrypted.data),new Uint8Array(plain));
 assert.equal(encrypted.info.v,'v2');
 const decoded=await decryptAttachment(encrypted.data,encrypted.info);
 assert.equal(new TextDecoder().decode(decoded),'Harbor attachment integrity test');
 const damaged=new Uint8Array(encrypted.data).slice();damaged[0]^=1;
 await assert.rejects(()=>decryptAttachment(damaged.buffer,encrypted.info));
});
test('Matrix encrypted key export rejects an incorrect passphrase',async()=>{
 await initAsync();
 const pass='test-only passphrase for a disposable key file';
 const armored=OlmMachine.encryptExportedRoomKeys('[]',pass,100000);
 assert.match(armored,/BEGIN MEGOLM SESSION DATA/);
 assert.equal(OlmMachine.decryptExportedRoomKeys(armored,pass),'[]');
 assert.throws(()=>OlmMachine.decryptExportedRoomKeys(armored,'wrong passphrase'));
});
