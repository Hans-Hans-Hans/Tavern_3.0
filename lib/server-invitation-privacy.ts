import { accountArtworkOwner, isManagedAccount, requestApi } from './api';
import { getMatrixClient } from './matrix';

export type ServerInvitationRules = Record<string, 'contacts' | 'nobody'>;
export type ServerInvitationPrivacy = { servers: ServerInvitationRules; invalid: boolean; revision: string; invitations: 'everyone' | 'contacts' | 'shared_server' | 'nobody' };
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
// Room v12 uses an unpadded URL-safe SHA-256 create-event hash. Its final
// sextet has two zero padding bits; accepting the shape grants no membership.
const serverId = (value: string) => /^![^\s/\\?#\x00-\x1f\x7f]{1,254}:[^\s/\\?#\x00-\x1f\x7f]{1,254}$/.test(value)
  || /^![A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
export function validServerInvitationRules(value: unknown): value is ServerInvitationRules {
  return record(value) && Object.keys(value).length <= 200 && Object.entries(value).every(([key, mode]) => serverId(key) && ['contacts', 'nobody'].includes(mode));
}
export function parseServerInvitationPrivacy(value: unknown): ServerInvitationPrivacy {
  if (!record(value) || !validServerInvitationRules(value.servers) || typeof value.invalid !== 'boolean'
    || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !['everyone', 'contacts', 'shared_server', 'nobody'].includes(value.invitations)) throw new Error('The server returned incomplete invitation preferences. Reload before editing.');
  return { servers: { ...value.servers }, invalid: value.invalid, revision: value.revision, invitations: value.invitations };
}
export function serverInvitationRuleKey(value: ServerInvitationRules) { return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))); }
export async function serverInvitationPrivacy(servers?: ServerInvitationRules, previous?: ServerInvitationPrivacy) {
  const owner = getMatrixClient(), actor = owner?.getUserId(), account = accountArtworkOwner();
  const current = () => { if (!owner || !actor || !isManagedAccount() || getMatrixClient() !== owner || owner.getUserId() !== actor || accountArtworkOwner() !== account) throw new Error('Your account changed. Reopen invitation preferences.'); };
  current();
  if (servers !== undefined && (!validServerInvitationRules(servers) || !previous)) throw new Error('Choose up to 200 server invitation restrictions.');
  const value = await requestApi('/social/server-invitation-privacy', servers === undefined ? undefined : { servers: { ...servers }, revision: previous!.revision }, servers === undefined ? 'GET' : 'PUT');
  current(); return parseServerInvitationPrivacy(value);
}
