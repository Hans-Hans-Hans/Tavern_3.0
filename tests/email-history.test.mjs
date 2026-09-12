import test from 'node:test';
import assert from 'node:assert/strict';
import * as wasm from '@matrix-org/matrix-sdk-crypto-wasm';
import {loadTs} from './load-ts.mjs';
import {encodeBase64} from 'matrix-js-sdk/lib/base64.js';
import {Method,ClientPrefix} from 'matrix-js-sdk/lib/http-api/index.js';
await wasm.initAsync();
const envelope=loadTs('../lib/history-envelope.ts',{});
globalThis.location={origin:'https://tavern.test'};
globalThis.localStorage={values:new Map(),getItem(k){return this.values.get(k)||null;},setItem(k,v){this.values.set(k,v);},removeItem(k){this.values.delete(k);}};
function fixture(){
 const f={account:{},active:null,backup:null,cache:null,version:null,package:null,revision:null,posts:0,restores:0,busy:false,uncertain:false};
 const user='@alice:test';
 const crypto={getSessionBackupPrivateKey:async()=>f.cache?new Uint8Array(f.cache):null,storeSessionBackupPrivateKey:async(bytes,version)=>{f.cache=new Uint8Array(bytes);f.version=version;},isKeyBackupTrusted:async backup=>{if(!f.cache)return{matchesDecryptionKey:false};const key=wasm.BackupDecryptionKey.fromBase64(encodeBase64(f.cache)),pub=key.megolmV1PublicKey;try{return{matchesDecryptionKey:pub.publicKeyBase64===backup.auth_data.public_key};}finally{pub.free();key.free();}},checkKeyBackupAndEnable:async()=>{},restoreKeyBackup:async()=>{f.restores++;}};
 const client={getCrypto:()=>crypto,getUserId:()=>user,getDeviceId:()=> 'D1',getHomeserverUrl:()=>location.origin+'/api/matrix',http:{authedRequest:async(method,path,query,body)=>{assert.equal(method,Method.Post);assert.equal(path,'/room_keys/version');f.posts++;if(f.uncertain)throw Error('Fixture request failed before acceptance');f.backup={version:String(f.posts),...body};return{version:f.backup.version};}}};f.active=client;
 const api={accountArtworkOwner:()=>f.account,isManagedAccount:()=>true,requestApi:async(path,body)=>{
 if(path==='/account/history/password'){assert.equal(body.password,'Correct password!');return{credentialEpoch:0};}
 if(path==='/account/history'&&!body)return{configured:!!f.package,revision:f.revision,emailReady:true,credentialEpoch:0,passwordChanged:false,backupVersion:f.backup?.version||null};
 if(path==='/account/history'){f.package=body.package;f.revision='new';return{revision:'new'};}
 if(path==='/account/history/complete'){assert.equal(body.code,'123456');return{package:f.package};}
 throw Error('Unexpected API route '+path);
 }};
 const login=loadTs('../lib/history-login.ts',{'./api':api});
 const mod=loadTs('../lib/email-history.ts',{'./api':api,'./matrix':{getMatrixClient:()=>f.active},'./backup':{discoverBackup:async()=>f.backup},'./history-envelope':envelope,'./history-login':login,'./security':{historyKeyOperation:async op=>{if(f.busy)throw Error('busy');f.busy=true;try{return await op();}finally{f.busy=false;}}},'matrix-js-sdk/lib/base64':{encodeBase64},'matrix-js-sdk/lib/http-api':{Method,ClientPrefix},'@matrix-org/matrix-sdk-crypto-wasm':wasm});
 return{...mod,f,client,crypto,login};
}
test('protect available history creates a native backup with POST and a password-encrypted package; a new device restores its exact key',async()=>{
 const t=fixture();await t.protectCurrentHistory('Correct password!');assert.equal(t.f.posts,1);assert.ok(t.f.package);const bytes=new Uint8Array(t.f.cache);t.f.cache=null;
 await t.recoverEmailHistory('challenge','123456','Correct password!');assert.deepEqual(t.f.cache,bytes);assert.equal(t.f.restores,1);assert.equal(t.f.version,'1');
});
test('a saved pending candidate resumes after uncertain POST without replacing its key',async()=>{
 const t=fixture();t.f.uncertain=true;await assert.rejects(t.protectCurrentHistory('Correct password!'));const candidate=new Uint8Array(t.f.cache);
 t.f.uncertain=false;await t.protectCurrentHistory('Correct password!');assert.deepEqual(t.f.cache,candidate);assert.ok(t.f.package);
});
test('an unrelated cached backup key is preserved and no native backup is posted',async()=>{
 const t=fixture();const previous=crypto.getRandomValues(new Uint8Array(32));t.f.cache=previous;
 await assert.rejects(t.protectCurrentHistory('Correct password!'),/holds another backup key/);assert.equal(t.f.posts,0);assert.deepEqual(t.f.cache,previous);
});
test('wrong password, backup rotation and account replacement never import a released key',async()=>{
 const t=fixture();await t.protectCurrentHistory('Correct password!');t.f.cache=null;
 await assert.rejects(t.recoverEmailHistory('c','123456','wrong'));assert.equal(t.f.cache,null);
 t.f.backup.version='rotated';await assert.rejects(t.recoverEmailHistory('c','123456','Correct password!'),/backup changed/);assert.equal(t.f.cache,null);
 t.f.backup.version=t.f.package.backupVersion;
 const pending=t.recoverEmailHistory('c','123456','Correct password!');t.f.account={};await assert.rejects(pending,/device changed/);assert.equal(t.f.cache,null);assert.equal(t.f.restores,0);
});
test('a login-derived key expires with account replacement and does not enroll for another account generation',async()=>{
 const t=fixture();t.login.rememberHistoryLogin({userId:'@alice:test',credentialEpoch:0},await envelope.historyPasswordKey('Correct password!'));
 assert.equal(t.hasHistoryLogin(),true);t.f.account={};assert.equal(t.hasHistoryLogin(),false);await assert.rejects(t.enableEmailHistory(),/Enter your account password/);t.login.forgetHistoryLogin();
});
