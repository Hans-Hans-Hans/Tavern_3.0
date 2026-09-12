import type { MatrixClient } from 'matrix-js-sdk';
import { isManagedAccount, requestApi } from './api';

export const maximumUploadBytes = 512 * 1024 * 1024;
export function effectiveUploadLimit(native: unknown, policy?: unknown): number {
  const values = [maximumUploadBytes];
  for (const value of [native, policy]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('The server returned an invalid file size limit. Try again.');
    values.push(value as number);
  }
  return Math.min(...values);
}
export function uploadLimitMessage(bytes: number) {
  return `Files can be up to ${(bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB on this server.`;
}
/** Read fresh policy before encryption; the gateway also checks actual bytes. */
export async function readUploadLimit(client: Pick<MatrixClient, 'getMediaConfig'>): Promise<number> {
  const managed = isManagedAccount();
  const [media, storage] = await Promise.all([client.getMediaConfig(), managed ? requestApi('/account/storage') : Promise.resolve(undefined)]);
  if (managed && storage?.maxUploadBytes === undefined) throw new Error('The file size limit could not be checked. Try again.');
  return effectiveUploadLimit(media['m.upload.size'], storage?.maxUploadBytes);
}
