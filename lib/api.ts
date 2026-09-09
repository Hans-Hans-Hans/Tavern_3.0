import { disposeCachedImageOwner } from './image-cache';
import { readImageResponse } from './response-image';

export class ApiError extends Error {
  constructor(message: string, public status: number, public details: any = {}) { super(message); }
}
let expectedDevice = '';
let artworkOwner = {};
export function accountArtworkOwner() { return artworkOwner; }
export function setAccountDevice(deviceId: string) { if (deviceId !== expectedDevice) { disposeCachedImageOwner(artworkOwner); artworkOwner = {}; } expectedDevice = deviceId; }
export async function requestApi<T = any>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch('/api' + path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', ...(expectedDevice ? { 'X-Tavern-Device': expectedDevice } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await response.json().catch(() => ({}));
  if(response.status===403)notifyAccountRequirement(data);
  if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : 'The request could not be completed. Please try again.', response.status, data);
  return data;
}
/** Upload public profile artwork through the same quota-enforced account gateway as chat media. */
export async function uploadAccountArtwork(blob: Blob): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || blob.size > 2 * 1024 * 1024) throw new Error('Choose an optimized image smaller than 2 MiB.');
  const device = expectedDevice, owner = artworkOwner;
  if (!device) throw new Error('Sign in before uploading artwork.');
  const response = await fetch('/api/matrix/_matrix/media/v3/upload', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': blob.type, 'X-Tavern-Device': device, Authorization: 'Bearer cookie-session:' + device }, body: blob, signal: AbortSignal.timeout(45000) });
  if (owner !== artworkOwner) { await response.body?.cancel().catch(() => {}); throw new Error('Your account changed during upload. Reopen this form.'); }
  const data = await response.json().catch(() => ({}));
  if (response.status === 403) notifyAccountRequirement(data);
  if (owner !== artworkOwner) throw new Error('Your account changed during upload. Reopen this form.');
  if (!response.ok) throw new ApiError(data.error || data.message || 'The avatar could not be uploaded. Try again.', response.status, data);
  if (typeof data.content_uri !== 'string' || !/^mxc:\/\/[^/\s?#]+\/[A-Za-z0-9_-]+$/.test(data.content_uri)) throw new Error('The server did not return a valid uploaded avatar.');
  return data.content_uri;
}
export async function fetchAccountArtwork(path: string, signal: AbortSignal): Promise<Blob> {
  const device = expectedDevice, owner = artworkOwner;
  if (!device || !path.startsWith('/api/matrix/_matrix/client/v1/media/thumbnail/')) throw new Error('Sign in to load this avatar.');
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal, referrerPolicy: 'no-referrer',
    headers: { 'X-Tavern-Device': device, Authorization: 'Bearer cookie-session:' + device } });
  return readImageResponse(response, 2 * 1024 * 1024, () => owner === artworkOwner, signal);
}
export type AccountSession = { userId: string; deviceId: string; baseUrl: string; admin: boolean; displayName?: string; email?: string; emailVerified?: boolean; passwordChangeRequired?: boolean; mfaEnrollmentRequired?: boolean };
let managed = false;
export function setManagedAccount(value: boolean) { managed = value; }
export function isManagedAccount() { return managed; }
export function accountSignedOut(notice?: string) { setAccountDevice(''); window.dispatchEvent(new CustomEvent('tavern:signout', { detail: typeof notice === 'string' ? notice.slice(0, 600) : '' })); }

export function notifyAccountRequirement(data:any){if(['MFA_ENROLLMENT_REQUIRED','PASSWORD_CHANGE_REQUIRED'].includes(data?.errcode||data?.code))window.dispatchEvent(new Event('tavern:account-requirement'));}
