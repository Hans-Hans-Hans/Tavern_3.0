import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as encryption from 'matrix-encrypt-attachment';
import { loadTs } from './load-ts.mjs';

const MiB = 1048576;
function limits(policy = 20 * MiB) {
  return loadTs('../lib/upload-limits.ts', { './api': { isManagedAccount: () => true, requestApi: async () => ({ maxUploadBytes: policy }) } });
}
test('file size follows the smaller admin, native, and application ceiling', async () => {
  const model = limits();
  assert.equal(model.effectiveUploadLimit(512 * MiB, 50 * MiB), 50 * MiB);
  assert.equal(model.effectiveUploadLimit(10 * MiB, 50 * MiB), 10 * MiB);
  assert.equal(model.effectiveUploadLimit(1024 * MiB, 1024 * MiB), 512 * MiB);
  assert.equal(model.effectiveUploadLimit(undefined, 25 * MiB), 25 * MiB);
  for (const invalid of [0, -1, '52428800', NaN, 1.5]) assert.throws(() => model.effectiveUploadLimit(invalid, 50 * MiB));
  assert.equal(await model.readUploadLimit({ getMediaConfig: async () => ({ 'm.upload.size': 100 * MiB }) }), 20 * MiB);
  await assert.rejects(limits(undefined).readUploadLimit({ getMediaConfig: async () => { throw new Error('offline'); } }), /offline/);
});

// Execute the actual upload function, including real attachment encryption and
// ownership checks. Only the HTTP destination and thumbnail generation are boundaries.
const source = ts.createSourceFile('matrix.ts', readFileSync(new URL('../lib/matrix.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const upload = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'uploadMatrixFile').getText(source);
const compiled = ts.transpileModule(upload, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function uploadFixture(policy = 20 * MiB, native = 512 * MiB) {
  let owner = {};
  const room = { hasEncryptionStateEvent: () => true, getMyMembership: () => 'join' }, sent = [];
  const client = { getUserId: () => '@alice:test', getDeviceId: () => 'DEVICE', getHomeserverUrl: () => 'https://tavern.test', getRoom: () => room,
    getMediaConfig: async () => ({ 'm.upload.size': native }),
    uploadContent: async (blob, options) => { sent.push({ blob, options }); return { content_uri: 'mxc://tavern.test/file' }; } };
  const model = limits(policy), exports = {}, pending = new Map();
  new Function('require', 'exports', 'requireClient', 'roomRequired', 'accountArtworkOwner', 'client', 'pendingFiles', 'readUploadLimit', 'uploadLimitMessage', compiled)(
    name => { if (name === 'matrix-encrypt-attachment') return encryption; if (name === './media-processing') return { createMediaPreview: async () => null }; throw new Error('Unexpected dependency: ' + name); },
    exports, () => client, () => room, () => owner, client, pending, model.readUploadLimit, model.uploadLimitMessage);
  return { upload: exports.uploadMatrixFile, sent, pending, client, replaceOwner: () => { owner = {}; } };
}
test('a 24 MiB file uploads encrypted and explicitly downloads above the preview cap', async t => {
  const f = uploadFixture(50 * MiB), original = new Uint8Array(24 * MiB).fill(37);
  const result = await f.upload(new File([original], 'large.bin', { type: 'application/octet-stream' }), '!room:test');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].options.includeFilename, false);
  assert.equal(f.sent[0].blob.size, original.length);
  const ciphertext = await f.sent[0].blob.arrayBuffer();
  const hash = bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  assert.notEqual(hash(ciphertext), hash(original));
  const transfer = loadTs('../lib/attachment-transfer.ts', { './matrix-media': { authenticatedMatrixMediaUrl: () => 'https://tavern.test/api/matrix/_matrix/client/v1/media/download/tavern.test/file' }, 'matrix-encrypt-attachment': encryption });
  f.client.getAccessToken = () => 'cookie-session:DEVICE';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /\/api\/matrix\/_matrix\/client\/v1\/media\/download\//);
    assert.equal(options.headers.Authorization, 'Bearer cookie-session:DEVICE');
    return new Response(ciphertext, { headers: { 'Content-Length': String(ciphertext.byteLength) } });
  });
  const downloadSource = source.statements.filter(node => ts.isFunctionDeclaration(node) && ['matrixFileBlob', 'downloadMatrixFile'].includes(node.name?.text)).map(node => node.getText(source)).join('\n');
  const downloads = {}, saved = [];
  new Function('exports', 'requireClient', 'client', 'accountArtworkOwner', 'readMatrixAttachment', 'maximumUploadBytes', 'downloadBlob', ts.transpileModule(downloadSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(downloads, () => f.client, f.client, () => 'OWNER', transfer.readMatrixAttachment, limits().maximumUploadBytes, (blob, name) => saved.push({ blob, name }));
  await assert.rejects(downloads.matrixFileBlob(result), /too large to preview/);
  await downloads.downloadMatrixFile(result);
  assert.equal(saved[0].name, 'large.bin');
  assert.equal(hash(await saved[0].blob.arrayBuffer()), hash(original));
  assert.equal(result.size, original.length);
  assert.equal(f.pending.size, 1);
});
test('a smaller current limit rejects before reading or sending file contents', async () => {
  const f = uploadFixture(10 * MiB);
  const file = { size: 16 * MiB, arrayBuffer: () => { throw new Error('Must not read rejected file'); } };
  await assert.rejects(f.upload(file, '!room:test'), /up to 10 MiB/);
  assert.equal(f.sent.length, 0);
});
test('an account change while fetching limits cannot encrypt or upload under the old session', async () => {
  const f = uploadFixture();
  f.client.getMediaConfig = async () => { f.replaceOwner(); return { 'm.upload.size': 512 * MiB }; };
  await assert.rejects(f.upload(new File(['hello'], 'hello.txt'), '!room:test'), /account, membership or encryption changed/);
  assert.equal(f.sent.length, 0);
});
