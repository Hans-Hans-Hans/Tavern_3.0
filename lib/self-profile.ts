import type { MatrixClient } from 'matrix-js-sdk';
import { Method } from 'matrix-js-sdk/lib/http-api/method';

type NativeProfile = { name: string; avatar: string };
type Entry = { controller: AbortController; data?: NativeProfile; task: Promise<void> };
const profiles = new WeakMap<MatrixClient, Entry>();
const cleanName = (value: unknown) => typeof value === 'string' ? value.slice(0, 255) : '';
const cleanAvatar = (value: unknown) => typeof value === 'string' && value.length <= 1024 && /^mxc:\/\/[^\s/?#]+\/[^\s/?#]+$/.test(value) ? value : '';

/** Read-only fallback for native profiles when presence has not populated User. */
export function nativeSelfProfile(client: MatrixClient | null | undefined): NativeProfile {
  const me = client?.getUserId() || '', user = client?.getUser(me), saved = client ? profiles.get(client)?.data : undefined;
  return { name: user ? cleanName(user.displayName) || me : saved?.name || me, avatar: user ? cleanAvatar(user.avatarUrl) : saved?.avatar || '' };
}
export function clearSelfProfile(client: MatrixClient) { const entry = profiles.get(client); profiles.delete(client); entry?.controller.abort(); }
export function hydrateSelfProfile(client: MatrixClient, stillOwned: () => boolean): Promise<void> {
  const previous = profiles.get(client); if (previous) return previous.task;
  const me = client.getUserId(); if (!me || !stillOwned()) return Promise.resolve();
  const user = client.getUser(me), oldName = user?.displayName, oldAvatar = user?.avatarUrl;
  const entry: Entry = { controller: new AbortController(), task: Promise.resolve() }; profiles.set(client, entry);
  // This is the authenticated native getProfileInfo route, with explicit request
  // cancellation and timeout instead of an unbounded background profile fetch.
  entry.task = client.http.authedRequest<{ displayname?: string; avatar_url?: string }>(Method.Get, '/profile/' + encodeURIComponent(me), undefined, undefined, { localTimeoutMs: 5000, abortSignal: entry.controller.signal }).then(value => {
    if (!stillOwned() || profiles.get(client) !== entry || client.getUserId() !== me) return;
    const current = client.getUser(me);
    entry.data = { name: cleanName(value.displayname), avatar: cleanAvatar(value.avatar_url) };
    // Populate only unchanged native SDK fields; room-specific names and Tavern
    // account metadata are never copied into the global profile or written back.
    if (current === user && current) {
      if (current.displayName === oldName) current.setDisplayName(entry.data.name || me);
      if (current.avatarUrl === oldAvatar) current.setAvatarUrl(entry.data.avatar);
    } else if (!user && current) {
      // Sync may create the User while the request is in flight. Fill only its
      // initial placeholders; later native profile changes remain authoritative.
      if (!current.displayName || current.displayName === me) current.setDisplayName(entry.data.name || me);
      if (!current.avatarUrl) current.setAvatarUrl(entry.data.avatar);
    }
  }).catch(() => {});
  return entry.task;
}
