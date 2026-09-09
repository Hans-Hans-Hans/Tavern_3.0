const reserved = new Set(['admin', 'api', 'auth', 'login', 'register', 'settings', 'health', 'assets', 'account', 'invite']);
export function validInvitationName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(value) && !value.includes('--') && !reserved.has(value);
}
export function validInvitationToken(value: unknown): value is string {
  return typeof value === 'string' && (/^[A-Za-z0-9_-]{32,80}$/.test(value) || value.startsWith('v:') && validInvitationName(value.slice(2)));
}
export function invitationToken(location: { pathname: string; search: string }): string {
  const query = new URLSearchParams(location.search);
  if (query.has('invite')) {
    const values = query.getAll('invite');
    return values.length === 1 && validInvitationToken(values[0]) ? values[0] : '';
  }
  const match = /^\/invite\/([^/]+)\/?$/.exec(location.pathname);
  return match && validInvitationName(match[1]) ? 'v:' + match[1] : '';
}
export function customInvitationUrl(slug: string, origin: string): string {
  if (!validInvitationName(slug)) throw new Error('This invitation name is invalid.');
  return new URL('/invite/' + slug, origin).href;
}
export function clearInvitationUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('invite');
  const match = /^\/invite\/([^/]+)\/?$/.exec(url.pathname);
  if (match && validInvitationName(match[1])) url.pathname = '/';
  return url.href;
}
