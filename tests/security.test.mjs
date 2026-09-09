import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
function fixture({identity=false,storage=false,backup=false}={}) {
  const calls=[],cache={};let authenticated=false,failSigning=false,metadata=storage?['key',{algorithm:'m.secret_storage.v1.aes-hmac-sha2',mac:'mac',iv:'iv'}]:null;
  const api=loadTs('../lib/security.ts',{'./local-history-recovery':{recoverLocalHistory:async()=>({keys:0,stores:0,skipped:0,limited:false,supported:true})},'./backup':{discoverBackup:async()=>backup?{version:'1'}:null,createOrResumeBackup:async()=>{backup=true;}},'matrix-js-sdk/lib/crypto-api':{CryptoEvent:{},VerificationPhase:{Cancelled:5,Done:6},VerificationRequestEvent:{Change:'change'},VerifierEvent:{ShowSas:'sas',Cancel:'cancel'},decodeRecoveryKey:s=>{if(s!=='valid')throw new Error('Invalid key');return new Uint8Array(32).fill(7);}}});
  const crypto={
    isCrossSigningReady:async()=>identity,
    userHasCrossSigningKeys:async()=>identity,
    getKeyBackupInfo:async()=>backup?{version:'1'}:null,
    createRecoveryKeyFromPassphrase:async()=>({privateKey:new Uint8Array(32).fill(7),encodedPrivateKey:'valid'}),
    bootstrapSecretStorage:async opts=>{calls.push(['storage',opts]);if(opts.createSecretStorageKey){const key=await opts.createSecretStorageKey();assert.equal(key.privateKey[0],7);metadata=['key',{algorithm:'m.secret_storage.v1.aes-hmac-sha2',mac:'mac',iv:'iv'}];cache.key=new Uint8Array(key.privateKey);}if(opts.setupNewKeyBackup)backup=true;},
    bootstrapCrossSigning:async opts=>{calls.push(['sign',opts]);if(failSigning)throw new Error('Wrong password');identity=true;authenticated=true;},
    getCrossSigningStatus:async()=>({privateKeysInSecretStorage:true,privateKeysCachedLocally:{masterKey:authenticated,selfSigningKey:authenticated,userSigningKey:authenticated}}),
    checkKeyBackupAndEnable:async()=>{},loadSessionBackupPrivateKeyFromSecretStorage:async()=>{},restoreKeyBackup:async()=>{},
    getActiveSessionBackupVersion:async()=>backup?'1':null,
    isSecretStorageReady:async()=>!!metadata,getDeviceVerificationStatus:async()=>({isVerified:()=>authenticated}),isKeyBackupTrusted:async()=>({matchesDecryptionKey:authenticated&&backup,trusted:authenticated}),
  };
  const client={getCrypto:()=>crypto,getUserId:()=>'@alice:test',getDeviceId:()=>'A',on(){},off(){},secretStorage:{getKey:async()=>metadata,getDefaultKeyId:async()=>'key',checkKey:async()=>true}};
  api.initializeSecurity(client);
  return{api,client,crypto,calls,cache,setFailSigning:v=>failSigning=v};
}
test('existing public identity and secret storage block fresh setup without mutations',async()=>{
  for(const value of [{identity:true},{storage:true},{backup:true}]){const f=fixture(value);await assert.rejects(f.api.generateRecoveryKey());assert.equal(f.calls.length,0);}
});
test('UI cleanup cannot erase the operation-owned recovery key',async()=>{
  const f=fixture(),key=await f.api.generateRecoveryKey();let release;const gate=new Promise(r=>release=r);let count=0;
  f.crypto.userHasCrossSigningKeys=async()=>{if(count++===0)await gate;return false;};
  const operation=f.api.setupRecovery(key,'password');key.privateKey.fill(0);release();await operation;assert.equal(f.cache.key[0],7);assert.equal(f.api.securityOperationInProgress(),false);
});
test('interrupted identity upload can resume using the saved key',async()=>{
  const f=fixture(),key=await f.api.generateRecoveryKey();f.setFailSigning(true);await assert.rejects(f.api.setupRecovery(key,'wrong'));f.setFailSigning(false);
  const messages=[];await f.api.recoverEncryption('valid',false,m=>messages.push(m),true,'correct');
  assert.ok(f.calls.some(([kind,opts])=>kind==='sign'&&opts.setupNewCrossSigning===true));assert.match(messages.at(-1),/active/);
});
test('malformed recovery key makes no changes',async()=>{const f=fixture({identity:true,storage:true});await assert.rejects(f.api.recoverEncryption('invalid',false,()=>{}));assert.equal(f.calls.length,0);});
test('recovering identity without backup never reports automatic backup active',async()=>{const f=fixture({identity:true,storage:true}),messages=[];await f.api.recoverEncryption('valid',false,m=>messages.push(m));assert.match(messages.at(-1),/No trusted backup/);assert.equal(f.calls.filter(([kind,opts])=>kind==='storage'&&opts.setupNewKeyBackup).length,0);});
test('failed recovery releases exclusive operation lock',async()=>{const f=fixture({identity:true,storage:true});await assert.rejects(f.api.recoverEncryption('bad',false,()=>{}));assert.equal(f.api.securityOperationInProgress(),false);});

test('recaching an in-use recovery key keeps it valid until operation cleanup',async()=>{const f=fixture(),callbacks=f.api.cryptoCallbacks(()=>f.client);callbacks.cacheSecretStorageKey('key',{},new Uint8Array(32).fill(7));const [,held]=await callbacks.getSecretStorageKey({keys:{key:{}}});callbacks.cacheSecretStorageKey('key',{},held);assert.equal(held[0],7);f.api.clearRecoveryKeys();assert.equal(held[0],0);assert.equal(await callbacks.getSecretStorageKey({keys:{key:{}}}),null);});

test('status distinguishes an existing server backup from keys available on this device',async()=>{
 const f=fixture({identity:true,storage:true,backup:true}),status=await f.api.securityStatus();
 assert.equal(status.serverBackupVersion,'1');assert.equal(status.canRestoreBackup,false);assert.equal(status.recoveryConfigured,true);
 await f.api.recoverEncryption('valid',true,()=>{});assert.equal((await f.api.securityStatus()).canRestoreBackup,true);
});
test('a session change while recovery metadata loads prevents secret caching or identity mutation',async()=>{
 const f=fixture({identity:true,storage:true});let release;const gate=new Promise(r=>release=r),get=f.client.secretStorage.getKey;
 f.client.secretStorage.getKey=async()=>{await gate;return get();};const recovery=f.api.recoverEncryption('valid',true,()=>{});
 f.api.resetSecurity();release();await assert.rejects(recovery,/session changed/);assert.equal(f.calls.length,0);
 assert.equal(await f.api.cryptoCallbacks(()=>f.client).getSecretStorageKey({keys:{key:{}}}),null);
});
test('session changes after key authentication stop before using the key for cross signing',async()=>{
 const f=fixture({identity:true,storage:true});f.client.secretStorage.checkKey=async()=>{f.api.resetSecurity();return true;};
 await assert.rejects(f.api.recoverEncryption('valid',true,()=>{}),/session changed/);assert.equal(f.calls.length,0);
});
test('restoring all history calls backup restore and preserves the current backup version',async()=>{
 const f=fixture({identity:true,storage:true,backup:true});let restored=0;f.crypto.restoreKeyBackup=async opts=>{restored++;opts.progressCallback({stage:'load_keys'});};
 await f.api.recoverEncryption('valid',true,()=>{});assert.equal(restored,1);assert.equal((await f.api.securityStatus()).serverBackupVersion,'1');
});

test('a trusted upload backup with a mismatched cached private key is not reported as restorable',async()=>{
 const f=fixture({identity:true,storage:true,backup:true});f.crypto.isKeyBackupTrusted=async()=>({trusted:true,matchesDecryptionKey:false});
 assert.equal((await f.api.securityStatus()).canRestoreBackup,false);
});

test('a generated recovery key cannot configure a replacement signed-in account',async()=>{
 const f=fixture(),key=await f.api.generateRecoveryKey();
 f.api.initializeSecurity({...f.client,getUserId:()=>'@bob:test',getDeviceId:()=>'B'});
 await assert.rejects(f.api.setupRecovery(key,'old account password'),/session changed/);assert.equal(f.calls.length,0);
 key.privateKey.fill(0);
});
