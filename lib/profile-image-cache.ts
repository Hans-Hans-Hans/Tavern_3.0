import { getMatrixClient } from './matrix';
import { profileImageBlob } from './community';
import { acquireCachedImage } from './image-cache';

/** One authenticated fetch per image/size/session; released entries have bounded memory. */
export function acquireProfileImage(mxc: string, size: number, height = size) {
  const client = getMatrixClient(); if (!client) return { promise: Promise.reject<string>(new Error('Sign in to load profiles.')), release: () => {} };
  return acquireCachedImage(client, `${size}x${height}:${mxc}`, signal => profileImageBlob(mxc, size, signal, height), () => getMatrixClient() === client);
}
