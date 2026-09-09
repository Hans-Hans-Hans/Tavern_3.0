import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { canManageServerSystemMessages, emptySystemMessageSettings, loadServerSystemMessages, saveServerSystemMessages, type ServerSystemMessages, type SystemMessageSettings } from '@/lib/server-system-messages';

export function ServerSystemMessagesSettings({ serverId }: { serverId: string }) {
  const [, redraw] = useState(0); useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  const client = getMatrixClient(), account = accountArtworkOwner(), allowed = canManageServerSystemMessages(serverId);
  const scope = useRef({ client, account, serverId, allowed, live: true });
  if (scope.current.client !== client || scope.current.account !== account || scope.current.serverId !== serverId || scope.current.allowed !== allowed) { scope.current.live = false; scope.current = { client, account, serverId, allowed, live: true }; }
  const owner = scope.current, current = () => owner.live && scope.current === owner && getMatrixClient() === client && accountArtworkOwner() === account;
  const empty = () => ({ owner, data: null as ServerSystemMessages | null, draft: emptySystemMessageSettings(), busy: false, error: '', notice: '', confirmation: '', blocked: false });
  const [state, setState] = useState(empty), view = state.owner === owner ? state : empty();
  const update = (patch: Partial<typeof state>) => { if (current()) setState(previous => current() ? { ...(previous.owner === owner ? previous : empty()), ...patch } : previous); };
  async function reload() {
    if (!current() || !allowed) return;
    update({ busy: true, error: '', notice: '' });
    try { const data = await loadServerSystemMessages(serverId); update({ data, draft: data.settings ? { ...data.settings } : emptySystemMessageSettings(), confirmation: '', blocked: false }); }
    catch (failure) { update({ error: (failure as Error).message, blocked: true }); }
    finally { update({ busy: false }); }
  }
  useEffect(() => { owner.live = true; if (allowed) void reload(); return () => { owner.live = false; }; }, [owner]);
  if (!allowed) return <section className="product-section"><h3>System notices</h3><p>System notice settings require a signed-in Tavern account, current server membership, native state authority and permission to manage this server.</p></section>;
  const { data, draft, busy, error, notice, confirmation, blocked } = view;
  const setDraft = (patch: Partial<SystemMessageSettings>) => update({ draft: { ...draft, ...patch }, notice: '' });
  const selected = data?.destinations.find(destination => destination.hookId === draft.hookId && destination.roomId === draft.channelId);
  const configured = !!(data?.enabled && data.ready), status = !configured ? 'Unconfigured' : data?.settings?.enabled ? 'Enabled' : 'Off';
  return <section className="product-section"><h3>System notices</h3>
    <p>Post server join and leave notices through an existing encrypted webhook. Notices describe server membership changes; private discussions and message content are not forwarded.</p>
    {busy && <p role="status">{data ? 'Checking system notice settings…' : 'Loading system notice settings…'}</p>}
    {data && <><p><strong>System notices: {status}</strong></p>
      {!configured && <p>The optional encrypted bot is not ready for system notices. Ask an instance administrator to provision its account, verified device and approved room recipients. A saved route can still be turned off.</p>}
      <form className="dialog-form" onSubmit={async event => {
        event.preventDefault(); if (busy || blocked || !current()) return;
        update({ busy: true, error: '', notice: '' });
        try { const saved = await saveServerSystemMessages(serverId, draft, data, confirmation); update({ data: saved, draft: { ...saved.settings! }, confirmation: '', notice: 'System notice settings saved. Delivery counts update when you reload.' }); }
        catch (failure) { update({ error: (failure as Error).message, blocked: [401, 403].includes((failure as any).status) }); }
        finally { update({ busy: false }); }
      }}><fieldset disabled={busy || blocked}>
        <label className="checkbox-row"><input type="checkbox" checked={draft.enabled} disabled={!configured && !draft.enabled} onChange={event => setDraft({ enabled: event.target.checked })}/>Post system notices</label>
        <label>Encrypted webhook destination<select value={selected?.hookId || (draft.hookId ? '__unavailable' : '')} disabled={!configured || !draft.enabled} onChange={event => { const destination = data.destinations.find(option => option.hookId === event.target.value); setDraft({ hookId: destination?.hookId || '', channelId: destination?.roomId || '' }); }}>
          <option value="">Choose a destination</option>{draft.hookId && !selected && <option value="__unavailable">Unavailable destination: {draft.hookId} · {draft.channelId}</option>}
          {data.destinations.map(destination => <option key={destination.hookId} value={destination.hookId}>{destination.name} · {getMatrixClient()?.getRoom(destination.roomId)?.name || destination.roomId}</option>)}
        </select></label>
        {configured && !data.destinations.length && <p>No eligible encrypted webhook destinations are available. Configure an enabled hook for a joined encrypted child channel, then reload these settings.</p>}
        <label className="checkbox-row"><input type="checkbox" checked={draft.joins} disabled={!draft.enabled} onChange={event => setDraft({ joins: event.target.checked })}/>Member joins</label>
        <label className="checkbox-row"><input type="checkbox" checked={draft.leaves} disabled={!draft.enabled} onChange={event => setDraft({ leaves: event.target.checked })}/>Member leaves</label>
        <p>Changing this route or its recipients can cancel pending notices. Notices already sent remain in the destination history. No members are joined automatically and device verification stays required.</p>
        <label>Confirm server ID<input autoComplete="off" spellCheck={false} placeholder={serverId} value={confirmation} onChange={event => update({ confirmation: event.target.value })}/></label><p>Type <code>{serverId}</code> to confirm this change.</p>
        <button className="primary-button" disabled={confirmation !== serverId}>Save system notice settings</button>
      </fieldset></form>
      <div aria-label="System notice delivery counts"><p>Queued: {data.counts.pending} · Sent: {data.counts.sent} · Cancelled: {data.counts.cancelled}</p><p>Queued notices may be waiting for the bot or verified encryption keys. Sent means the homeserver accepted an encrypted event; it does not confirm that every member received or read it. Cancelled stops further retries after changed permissions, audience, configuration or expiration; an earlier unconfirmed send may already be in the room history.</p></div>
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="connect-error">{error}</p>}
    <button className="secondary-button" type="button" disabled={busy} onClick={() => void reload()}>Reload settings and delivery status</button>
    {data && <p className="login-help">Reloading replaces your unsaved draft with the current server settings.</p>}
  </section>;
}
