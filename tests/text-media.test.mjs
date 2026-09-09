import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const { normalizeTextMedia, shouldSendOnKey } = loadTs('../lib/text-media.ts', { react: {}, './matrix': {} });
test('message keyboard preferences keep IME and multiline input safe', () => {
  const key={key:'Enter',shiftKey:false,ctrlKey:false,metaKey:false};
  assert.equal(shouldSendOnKey(key,true),true);
  assert.equal(shouldSendOnKey(key,false),false);
  assert.equal(shouldSendOnKey({...key,ctrlKey:true},false),true);
  assert.equal(shouldSendOnKey({...key,metaKey:true},false),true);
  assert.equal(shouldSendOnKey({...key,shiftKey:true,ctrlKey:true},false),false);
  assert.equal(shouldSendOnKey({...key,isComposing:true},true),false);
  assert.deepEqual(normalizeTextMedia({enterToSend:false,inlineImages:false}),{enterToSend:false,inlineImages:false});
  assert.deepEqual(normalizeTextMedia(null),{enterToSend:true,inlineImages:true});
});
