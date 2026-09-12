import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';
const {historyPasswordKey,wrapHistoryKey,unwrapHistoryKey}=loadTs('../lib/history-envelope.ts',{});
const backup={version:'1',publicKey:'a'.repeat(43)},user='@alice:test',origin='https://tavern.test';
test('a password-protected key survives a new browser cryptographic context without exposing an exportable password key',async()=>{
 const password=await historyPasswordKey('A strong account password');assert.equal(password.extractable,false);
 const bytes=crypto.getRandomValues(new Uint8Array(32));
 const wrapped=await wrapHistoryKey(password,user,origin,backup,bytes);
 const fresh=await historyPasswordKey('A strong account password');
 assert.deepEqual(await unwrapHistoryKey(fresh,user,origin,JSON.parse(JSON.stringify(wrapped))),bytes);
 assert.equal(wrapped.ciphertext.length,64);assert.equal(JSON.stringify(wrapped).includes(Buffer.from(bytes).toString('base64')),false);
 const again=await wrapHistoryKey(password,user,origin,backup,bytes);assert.notEqual(again.salt,wrapped.salt);assert.notEqual(again.iv,wrapped.iv);
});
test('wrong password, account, origin, backup version, public key and modified ciphertext cannot unlock history',async()=>{
 const password=await historyPasswordKey('Original password');const wrapped=await wrapHistoryKey(password,user,origin,backup,new Uint8Array(32));
 await assert.rejects(unwrapHistoryKey(await historyPasswordKey('Wrong password'),user,origin,wrapped));
 for(const [u,o,w] of [[user+'x',origin,wrapped],[user,origin+'x',wrapped],[user,origin,{...wrapped,backupVersion:'2'}],[user,origin,{...wrapped,publicKey:'b'.repeat(43)}],[user,origin,{...wrapped,ciphertext:'A'.repeat(64)}]])await assert.rejects(unwrapHistoryKey(password,u,o,w));
 await assert.rejects(unwrapHistoryKey(password,user,origin,{...wrapped,version:2}));
});
