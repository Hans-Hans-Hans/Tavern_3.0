export class ApiError extends Error {
  constructor(message: string, public status: number, public details: any = {}) { super(message); }
}
export async function requestApi<T = any>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch('/api' + path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : 'The request could not be completed. Please try again.', response.status, data);
  return data;
}
export type AccountSession = { userId: string; deviceId: string; baseUrl: string; admin: boolean; displayName?: string; email?: string; emailVerified?: boolean };
let managed = false;
export function setManagedAccount(value: boolean) { managed = value; }
export function isManagedAccount() { return managed; }
export function accountSignedOut() { window.dispatchEvent(new Event('tavern:signout')); }
