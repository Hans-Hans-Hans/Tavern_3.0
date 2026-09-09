import type { MatrixClient } from 'matrix-js-sdk';

/** Keep authenticated media on the client's gateway, including its path prefix. */
export function authenticatedMatrixMediaUrl(
  client: Pick<MatrixClient, 'getHomeserverUrl' | 'mxcUrlToHttp'>,
  mxc: string,
  thumbnail?: { width: number; height: number },
): string {
  const value = client.mxcUrlToHttp(mxc, thumbnail?.width, thumbnail?.height, thumbnail ? 'crop' : undefined, false, true, true);
  if (!value) throw new Error('Invalid Matrix media address.');
  const base = new URL(client.getHomeserverUrl()), target = new URL(value);
  if (target.origin !== base.origin || target.username || target.password || target.hash || target.searchParams.has('access_token')) {
    throw new Error('Invalid Matrix media origin.');
  }
  // The SDK resolves /_matrix/... against the origin and drops /api/matrix.
  // Reattach the configured prefix while supporting SDKs that retain it.
  const prefix = base.pathname.replace(/\/+$/, ''), mediaPath = '/_matrix/client/v1/media/';
  if (prefix && target.pathname.startsWith(mediaPath)) target.pathname = prefix + target.pathname;
  if (!target.pathname.startsWith(prefix + mediaPath)) throw new Error('Invalid Matrix media route.');
  return target.href;
}
