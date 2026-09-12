import { useEffect, useRef, useState } from 'react';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { readServerLayout } from '@/lib/community';
import { channelKinds, type ChannelKind } from '@/lib/channel-policy';
import { channelCreationOwner, channelSlowModes, channelTemplates, createTypedChannel, finishChannelCreation, isChannelCreationOwner, type ChannelCreationResult, type ChannelDraft } from '@/lib/channel-creation';
import './channel-creation.css';
import { readRolePolicy } from '@/lib/roles';

type Props = { serverId?: string; initialCategoryId?: string; members: { id: string; name: string }[]; policyEnabled: boolean; callsEnabled: boolean; onCreated: (roomId: string, isCurrent: () => boolean) => Promise<unknown> };
export function ChannelCreationForm(props: Props) {
  const [, refresh] = useState(0);
  useEffect(() => { const stop = onMatrixUpdate(() => refresh(value => value + 1)), timer = setInterval(() => refresh(value => value + 1), 500); return () => { stop(); clearInterval(timer); }; }, []);
  const client = getMatrixClient(), user = client?.getUserId(), device = client?.getDeviceId(), account = accountArtworkOwner(), serverId = props.serverId;
  const boundary = useRef({ client, user, device, account, serverId, revision: 0 });
  if (boundary.current.client !== client || boundary.current.user !== user || boundary.current.device !== device || boundary.current.account !== account || boundary.current.serverId !== serverId)
    boundary.current = { client, user, device, account, serverId, revision: boundary.current.revision + 1 };
  return <ChannelCreationEditor key={boundary.current.revision} {...props}/>;
}
function ChannelCreationEditor({ serverId, initialCategoryId = '', members, policyEnabled, callsEnabled, onCreated }: Props) {
  const [owner] = useState(channelCreationOwner), live = useRef(true), lock = useRef(false), receipt = useRef<ChannelCreationResult | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const current = () => live.current && isChannelCreationOwner(owner);
  const [draft, setDraft] = useState<ChannelDraft>({ name: '', description: '', kind: 'text', slowModeSeconds: 0, serverId, categoryId: initialCategoryId, members: [], icon: channelTemplates.text.icon });
  const [filter, setFilter] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<ChannelCreationResult | null>(null);
  const client = getMatrixClient(), server = serverId ? client?.getRoom(serverId) : null, layout = serverId ? readServerLayout(serverId) : null;
  const roles = serverId ? readRolePolicy(serverId) : null;
  const candidates = members.filter(member => member.id !== client?.getUserId() && (!serverId || server?.getMember(member.id)?.membership === 'join'));
  const shown = candidates.filter(member => (member.name + ' ' + member.id).toLocaleLowerCase().includes(filter.toLocaleLowerCase())).slice(0, 100);
  const template = channelTemplates[draft.kind], validOwner = isChannelCreationOwner(owner);
  function update(values: Partial<ChannelDraft>) { if (current() && !lock.current) setDraft(previous => ({ ...previous, ...values })); }
  async function submit(retry = false) {
    if (!current() || lock.current) return; lock.current = true; setBusy(true); setError('');
    try {
      const value = retry && receipt.current ? await finishChannelCreation(receipt.current) : await createTypedChannel(draft);
      if (!current()) return;
      receipt.current = value; setResult({ ...value, errors: [...value.errors], invited: [...value.invited], pendingMembers: [...value.pendingMembers] });
      if (!value.errors.length) { try { await onCreated(value.roomId, current); } catch { if (current()) setError('The channel was created, but opening it failed. Use Open channel or find it in All conversations.'); } }
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { lock.current = false; if (current()) setBusy(false); }
  }
  if (result) return <section className='channel-creation' aria-label='Channel creation result'>
    <h3>{result.name} was created</h3><p className='login-help'>The encrypted channel exists. Its room ID is <code>{result.roomId}</code>.</p>
    {serverId && <p>{result.linked ? `Added to ${server?.name || 'the server'}.` : 'Adding this channel to the server still needs to be completed.'}</p>}
    {draft.categoryId && <p>{result.categoryApplied ? 'Category placement saved.' : 'Category placement is still pending.'}</p>}
    {draft.privateRoles !== undefined && <p>{result.audienceApplied ? 'Private roles and members saved.' : 'Private access setup is still pending; this channel remains invite only until it finishes.'}</p>}
    {result.invited.length > 0 && <p>{result.invited.length} member invitation{result.invited.length === 1 ? '' : 's'} confirmed. Each member chooses whether to join.</p>}
    {result.pendingMembers.length > 0 && <p>Invitations pending: {result.pendingMembers.map(id => members.find(member => member.id === id)?.name || id).join(', ')}.</p>}
    {result.errors.map((message, index) => <p role='alert' className='connect-error' key={index}>{message}</p>)}
    <p className='login-help'>Retrying finishes this same channel. It does not create another room. You can also manage it later from All conversations.</p>
    {error && <p role='alert' className='connect-error'>{error}</p>}
    <div className='product-actions'>{result.errors.length > 0 && <button type='button' className='primary-button' disabled={busy || !validOwner} onClick={() => void submit(true)}>{busy ? 'Finishing…' : 'Retry remaining setup'}</button>}
      <button type='button' className='secondary-button' disabled={busy || !validOwner} onClick={async () => { if (!current()) return; try { await onCreated(result.roomId, current); } catch { if (current()) setError('Opening the channel failed. Find it in All conversations.'); } }}>Open channel</button></div>
  </section>;
  return <form className='dialog-form channel-creation' aria-label='Create channel' onSubmit={event => { event.preventDefault(); void submit(); }}>
    <fieldset disabled={busy || !validOwner}>
      <section className='channel-creation-destination' aria-label='Channel destination'><strong>{server ? `In ${server.name}` : 'Standalone conversation'}</strong><p>{server ? 'The channel has its own membership. Adding it to a server does not join every server member.' : 'This channel appears in All conversations. Choose a server before creating if you want it organized there.'}</p></section>
      <fieldset className='channel-type-picker'><legend>Channel type</legend><div className='channel-type-grid'>{Object.entries(channelKinds).map(([kind, name]) => <label className={'channel-type-option ' + (draft.kind === kind ? 'selected' : '')} key={kind}>
        <input type='radio' name='channel-type' value={kind} checked={draft.kind === kind} disabled={!policyEnabled && kind !== 'text'} onChange={() => update({ kind: kind as ChannelKind, icon: draft.icon === template.icon ? channelTemplates[kind as ChannelKind].icon : draft.icon })}/>
        <span aria-hidden='true'>{channelTemplates[kind as ChannelKind].icon}</span><span><strong>{name}</strong><small>{channelTemplates[kind as ChannelKind].description}</small></span>
      </label>)}</div></fieldset>
      {!policyEnabled && <p className='login-help'>This homeserver supports basic text creation. Additional channel behavior requires the Tavern policy module.</p>}
      <p className='channel-type-guidance'>{template.guidance}</p>
      {roles && roles.owner === client?.getUserId() && <fieldset><legend>Channel access</legend><label className='checkbox-row'><input type='checkbox' checked={draft.privateRoles !== undefined} onChange={event => update({ privateRoles: event.target.checked ? [] : undefined })}/>Private channel with selected roles and members</label>
        {draft.privateRoles !== undefined && <><p className='login-help'>Selected roles and the members chosen below can join. The server owner keeps access. Removing someone from every selected role and member list removes their membership; previously received history stays on their devices.</p><div className='dialog-member-list'>{roles.roles.map(role => <label className='checkbox-row' key={role.id}><input type='checkbox' checked={draft.privateRoles!.includes(role.id)} onChange={event => update({ privateRoles: event.target.checked ? [...draft.privateRoles!, role.id] : draft.privateRoles!.filter(id => id !== role.id) })}/>{role.icon} {role.name}</label>)}</div></>}
      </fieldset>}
      {['voice', 'video'].includes(draft.kind) && !callsEnabled && <p role='status' className='login-help'>Calls are currently disabled on this instance. You can prepare this channel, but calls require the administrator’s call setup.</p>}
      <div className='channel-creation-name'><label>Channel icon<input value={draft.icon} maxLength={16} onChange={event => update({ icon: event.target.value })}/></label><label>Channel name<input autoFocus required maxLength={60} placeholder={draft.kind === 'voice' ? 'e.g. lounge' : draft.kind === 'video' ? 'e.g. team-meetings' : draft.kind === 'forum' ? 'e.g. help-and-ideas' : 'e.g. weekend-projects'} value={draft.name} onChange={event => update({ name: event.target.value })}/></label></div>
      <label>{draft.kind === 'rules' ? 'Rules channel description' : 'Channel description'} <span className='optional'>optional</span><textarea value={draft.description} maxLength={500} placeholder={template.purpose} onChange={event => update({ description: event.target.value })}/></label>
      <p className='login-help'>The channel name and description are room metadata visible to members and the homeserver. Messages and attachments are end-to-end encrypted.</p>
      {layout && <label>Category<select value={draft.categoryId} onChange={event => update({ categoryId: event.target.value })}><option value=''>Uncategorized</option>{layout.categories.map(category => <option value={category.id} key={category.id}>{category.icon} {category.name}</option>)}</select></label>}
      {policyEnabled && <label>{['voice', 'video'].includes(draft.kind) ? 'Chat slow mode' : 'Slow mode'}<select value={draft.slowModeSeconds} onChange={event => update({ slowModeSeconds: Number(event.target.value) })}>{channelSlowModes.map(seconds => <option value={seconds} key={seconds}>{seconds === 0 ? 'Off' : seconds < 60 ? `${seconds} seconds` : seconds < 3600 ? `${seconds / 60} minutes` : `${seconds / 3600} hours`}</option>)}</select></label>}
      {policyEnabled && <p className='login-help'>Slow mode limits message frequency for ordinary members. Authorized moderators are exempt; audio is not rate limited by this setting.</p>}
      <details className='channel-invite-picker'><summary>Invite members now <span>({draft.members.length} selected)</span></summary>
        <p>Only selected members receive invitations. You can invite more people from channel settings later.</p>
        <label>Find a member<input type='search' value={filter} onChange={event => setFilter(event.target.value)}/></label>
        <div className='channel-invite-options'>{shown.map(member => <label key={member.id}><input type='checkbox' checked={draft.members.includes(member.id)} disabled={!draft.members.includes(member.id) && draft.members.length >= 50} onChange={event => update({ members: event.target.checked ? [...draft.members, member.id] : draft.members.filter(id => id !== member.id) })}/><span>{member.name}<small>{member.id}</small></span></label>)}</div>
        {!shown.length && <p>No matching joined members. Invitations can be added later.</p>}{candidates.length > 100 && <p>Showing up to 100 matches. Search for a specific member.</p>}
      </details>
      <p className='channel-creation-security'>Invite-only · Encrypted messages · History from joining · No federation</p>
      {error && <p role='alert' className='connect-error'>{error}</p>}
      <button className='primary-button' disabled={busy || !draft.name.trim() || !validOwner}>{busy ? 'Creating channel…' : `Create ${channelKinds[draft.kind].toLowerCase()} channel`}</button>
    </fieldset>
  </form>;
}
