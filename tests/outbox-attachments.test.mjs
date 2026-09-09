import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptAttachment } from 'matrix-encrypt-attachment';
import { loadTs } from './load-ts.mjs';
const model = loadTs('../lib/outbox-attachments.ts', {});
const owner = JSON.stringify(['@alice:local', 'DEVICE', 'https://local']);
const attachment = { id: 'file-1', name: 'private-note.txt', type: 'text/plain', size: 13, transactionId: 'send-f0' };

test('local file encryption round trips exact bytes with a nonextractable key and binds item, file and account', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const file = new File(['private bytes'], attachment.name, { type: attachment.type });
  const saved = await model.sealOutboxFile(key, owner, 'message-1', attachment, file, () => true);
  assert.equal(key.extractable, false); assert.equal(saved.ciphertext.byteLength, file.size + 16);
  assert.equal(JSON.stringify(saved).includes(attachment.name), false);
  assert.notDeepEqual(new Uint8Array(saved.ciphertext).slice(0, file.size), new Uint8Array(await file.arrayBuffer()));
  const opened = await model.openOutboxFile(key, owner, 'message-1', attachment, saved, () => true);
  assert.equal(await opened.text(), 'private bytes'); assert.equal(opened.name, attachment.name); assert.equal(opened.type, attachment.type);
  await assert.rejects(model.openOutboxFile(key, 'another account', 'message-1', attachment, saved, () => true));
  await assert.rejects(model.openOutboxFile(key, owner, 'message-2', attachment, saved, () => true));
  await assert.rejects(model.openOutboxFile(key, owner, 'message-1', { ...attachment, id: 'another-file' }, saved, () => true));
  saved.ciphertext = saved.ciphertext.slice(1); await assert.rejects(model.openOutboxFile(key, owner, 'message-1', attachment, saved, () => true));
});

test('a replacement account during file read cannot commit its encrypted copy', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  let current = true; const file = new File(['private bytes'], attachment.name, { type: attachment.type });
  const read = file.arrayBuffer.bind(file); file.arrayBuffer = async () => { const bytes = await read(); current = false; return bytes; };
  await assert.rejects(model.sealOutboxFile(key, owner, 'message-1', attachment, file, () => current), /account changed/);
});

test('actual Matrix encrypted descriptors retain their key and stable transaction across acknowledged partial delivery', async () => {
  const encryption = await encryptAttachment(new TextEncoder().encode('private bytes').buffer);
  const descriptor = { ...attachment, roomId: '!room:local', url: 'mxc://local/file', info: {}, file: { ...encryption.info, url: 'mxc://local/file' } };
  const first = { ...attachment, descriptor }, second = { ...first, id: 'file-2', transactionId: 'send-f1', descriptor: { ...descriptor, id: 'file-2' } };
  model.validateQueuedAttachments([first, second], '!room:local');
  const acknowledged = model.acknowledgeAttachment([first, second], first.id, first.transactionId, '$first');
  assert.equal(acknowledged[0].eventId, '$first'); assert.equal(acknowledged[1].eventId, undefined);
  assert.deepEqual(acknowledged[0].descriptor.file, descriptor.file); assert.equal(acknowledged[0].transactionId, 'send-f0');
  assert.throws(() => model.acknowledgeAttachment(acknowledged, first.id, 'new-transaction', '$duplicate'));
  assert.throws(() => model.acknowledgeAttachment(acknowledged, first.id, first.transactionId, '$different-event'));
  assert.deepEqual(model.acknowledgeAttachment(acknowledged, first.id, first.transactionId, '$first'), acknowledged);
});

test('queue bounds reject foreign-room descriptors and duplicate file or transaction identities', () => {
  const descriptor = { ...attachment, roomId: '!room:local', url: 'mxc://local/file', info: {}, file: null }, value = { ...attachment, descriptor };
  model.validateQueuedAttachments([value], '!room:local');
  assert.throws(() => model.validateQueuedAttachments([value], '!foreign:local'));
  assert.throws(() => model.validateQueuedAttachments([value, value], '!room:local'));
  assert.throws(() => model.validateQueuedAttachments([{ ...value, size: 10 * 1024 * 1024 + 1 }], '!room:local'));
  assert.throws(() => model.validateQueuedAttachments([{ ...value, descriptor: { ...descriptor, file: {} } }], '!room:local'));
  assert.throws(() => model.validateQueuedAttachments([{ ...attachment, eventId: '$pretend' }], '!room:local'));
  assert.equal(model.attachmentTransaction('original-nonce', 4), 'original-nonce-f4');
});
