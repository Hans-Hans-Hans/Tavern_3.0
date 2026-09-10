/** Widget SDK discovery omits cookies; authenticated operations use its driver. */
export function conferenceHomeserverUrl(homeserver: string, publicOrigin: string) {
  const url = new URL(homeserver);
  if (url.origin === publicOrigin && /^\/api\/matrix\/?$/.test(url.pathname) && !url.search && !url.hash && !url.username && !url.password) return publicOrigin;
  return homeserver;
}
