/** Only uploaded artwork is shareable; invitation secrets never belong in media URLs. */
export function invitationSplashMxc(value: unknown): string {
  return typeof value === 'string' && value.length <= 1024 && /^mxc:\/\/[^/\s?#\\]+\/[A-Za-z0-9_-]+$/.test(value) ? value : '';
}
export function invitationSplashUrl(value: unknown) {
  const mxc = invitationSplashMxc(value); if (!mxc) return '';
  const [server, media] = mxc.slice(6).split('/');
  return '/api/matrix/_matrix/client/v1/media/thumbnail/' + encodeURIComponent(server) + '/' + encodeURIComponent(media) + '?width=1200&height=400&method=crop';
}
