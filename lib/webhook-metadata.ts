export function webhookMetadata(value: unknown): { id: string; name: string; avatar: string } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(v.id) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80 || /[\x00-\x1f\x7f]/.test(v.name)) return null;
  return { id: v.id, name: v.name.trim(), avatar: webhookAvatarUrl(v.avatar_url) ? v.avatar_url as string : '' };
}
export function webhookAvatarUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  const match = /^mxc:\/\/([^/\s?#]+)\/([A-Za-z0-9_-]+)$/.exec(value);
  return match ? '/api/matrix/_matrix/client/v1/media/thumbnail/' + encodeURIComponent(match[1]) + '/' + encodeURIComponent(match[2]) + '?width=96&height=96&method=crop' : '';
}
