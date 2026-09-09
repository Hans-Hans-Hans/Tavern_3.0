import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner, isManagedAccount } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { serverInvitationPrivacy, serverInvitationRuleKey, type ServerInvitationPrivacy as Privacy, type ServerInvitationRules } from '@/lib/server-invitation-privacy';

export function ServerInvitationPrivacy() {
  const [, redraw] = useState(0); useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  const client = getMatrixClient(), actor = client?.getUserId(), account = accountArtworkOwner();
  const lifetime = useRef({ client, actor, account, live: true });
  if (lifetime.current.client !== client || lifetime.current.actor !== actor || lifetime.current.account !== account) { lifetime.current.live = false; lifetime.current = { client, actor, account, live: true }; }
  const owner = lifetime.current, current = () => owner.live && lifetime.current === owner && getMatrixClient() === client && client?.getUserId() === actor && accountArtworkOwner() === account;
  const empty = () => ({ owner, saved: null as Privacy | null, rules: {} as ServerInvitationRules, busy: false, error: '', notice: '' });
  const [state, setState] = useState(empty), view = state.owner === owner ? state : empty();
  const update = (patch: Partial<typeof state>) => { if (current()) setState(previous => current() ? { ...(previous.owner === owner ? previous : empty()), ...patch } : previous); };
  async function load() {
    if (!current()) return; update({ busy: true, error: '', notice: '' });
    try { const saved = await serverInvitationPrivacy(); update({ saved, rules: { ...saved.servers } }); }
    catch (failure) { update({ error: (failure as Error).message }); }
    finally { update({ busy: false }); }
  }
  useEffect(() => { owner.live = true; if (isManagedAccount() && client) void load(); return () => { owner.live = false; }; }, [owner]);
  if (!isManagedAccount() || !client) return null;
  const { saved, rules, busy, error, notice } = view;
  const joined = new Map(client.getRooms().filter(room => room.isSpaceRoom() && room.getMyMembership() === 'join').map(room => [room.roomId, room]));
  const servers = [...new Set([...joined.keys(), ...Object.keys(rules)])].sort((a, b) => (joined.get(a)?.name || a).localeCompare(joined.get(b)?.name || b));
  const changed = !!saved && (saved.invalid || serverInvitationRuleKey(saved.servers) !== serverInvitationRuleKey(rules));
  return <section className="product-section"><h3>Invitations from server members</h3>
    <p>Add restrictions for people who share a server with you. Your global invitation preference still applies. If you share several servers, every applicable restriction must allow the invitation.</p>
    <p>These settings cover new DM, group, channel and server invitations. They do not remove existing memberships or hide existing history. A restriction applies only while both people belong to that server.</p>
    {busy && <p role="status">{saved ? 'Saving or loading server invitation preferences…' : 'Loading server invitation preferences…'}</p>}
    {saved && <form className="dialog-form" onSubmit={async event => {
      event.preventDefault(); if (!current() || busy || !changed) return;
      update({ busy: true, error: '', notice: '' });
      try { const result = await serverInvitationPrivacy(rules, saved); update({ saved: result, rules: { ...result.servers }, notice: 'Server invitation preferences saved.' }); }
      catch (failure) { update({ error: (failure as Error).message }); }
      finally { update({ busy: false }); }
    }}><fieldset disabled={busy}>
      {saved.invalid && <p role="alert">Saved server restrictions are invalid and new invitations are blocked. Saving this replacement explicitly repairs them.</p>}
      {!servers.length && <p>Join a server to add a restriction.</p>}
      {servers.map(server => <label key={server}>{joined.get(server)?.name || server}<select aria-label={'Invitation restriction for ' + server} value={rules[server] || 'inherit'} onChange={event => {
        const next = { ...rules }; if (event.target.value === 'inherit') delete next[server]; else next[server] = event.target.value as 'contacts' | 'nobody'; update({ rules: next, notice: '' });
      }}><option value="inherit">Use global preference</option><option value="contacts" disabled={!joined.has(server)}>Accepted contacts only</option><option value="nobody" disabled={!joined.has(server)}>Block new invitations</option></select>{!joined.has(server) && <small>You are no longer joined. You can remove this saved restriction.</small>}</label>)}
      <button className="primary-button" disabled={!changed}>{saved.invalid ? 'Replace invalid server restrictions' : 'Save server invitation preferences'}</button>
    </fieldset></form>}
    {error && <p role="alert" className="connect-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void load()}>Reload server invitation preferences</button>
    {saved && <p className="login-help">Reload replaces your unsaved server restrictions.</p>}
  </section>;
}
