export type HistoryEnvelope = { version: 1; backupVersion: string; publicKey: string; salt: string; iv: string; ciphertext: string };
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function decode(value: string, length: number) {
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (bytes.length !== length || encode(bytes) !== value) throw new Error('Invalid encrypted history package.');
  return bytes;
}
export async function historyPasswordKey(password: string) {
  if (!password || password.length > 4096) throw new Error('Enter your account password.');
  const bytes = encoder.encode(password);
  try { return await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']); }
  finally { bytes.fill(0); }
}
async function key(password: CryptoKey, salt: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, password, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function aad(user: string, origin: string, envelope: Pick<HistoryEnvelope, 'backupVersion' | 'publicKey'>) {
  return encoder.encode(JSON.stringify(['io.tavern.email-history', 1, user, origin, envelope.backupVersion, envelope.publicKey]));
}
export async function wrapHistoryKey(password: CryptoKey, user: string, origin: string, backup: { version: string; publicKey: string }, bytes: Uint8Array<ArrayBuffer>): Promise<HistoryEnvelope> {
  if (bytes.length !== 32) throw new Error('Invalid history key.');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const header = { version: 1 as const, backupVersion: backup.version, publicKey: backup.publicKey };
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(user, origin, header) }, await key(password, salt), bytes);
  return { ...header, salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function unwrapHistoryKey(password: CryptoKey, user: string, origin: string, envelope: HistoryEnvelope): Promise<Uint8Array<ArrayBuffer>> {
  if (!envelope || envelope.version !== 1 || typeof envelope.backupVersion !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,255}$/.test(envelope.backupVersion) || !/^[A-Za-z0-9+/]{43}=?$/.test(envelope.publicKey)) throw new Error('Invalid encrypted history package.');
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv, 12), additionalData: aad(user, origin, envelope) }, await key(password, decode(envelope.salt, 16)), decode(envelope.ciphertext, 48)));
  } catch { throw new Error('This password cannot unlock the saved history key. If your password was reset, use the previous password, a known device, or your recovery key.'); }
}
