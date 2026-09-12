import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { matrixApi, getMatrixClient } from '@/lib/matrix';
import { accountArtworkOwner } from '@/lib/api';
import { readInstanceConfig } from '@/lib/instance';
import { channelKinds, type ChannelKind } from '@/lib/channel-policy';
import { channelTemplates, createTypedChannel, finishChannelCreation, type ChannelCreationResult } from '@/lib/channel-creation';
import { serverTemplates, starterCategories, validateStarterChannels, type StarterCategory, type StarterChannel } from '@/lib/server-templates';
import { terminology, type Naming } from '@/lib/terminology';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CommunityImage, ImageEditor } from './community-settings';
import { ExperienceError } from './experience-error';
import './experience.css';
import './server-creation.css';

type DraftChannel = StarterChannel & { included: boolean };
const steps = ['Your space', 'Channels', 'Review'];

export function ServerDialog({ open, naming, onClose, onCreated }: { open: boolean; naming: Naming; onClose: () => void; onCreated: (id: string, roomId: string | undefined, isCurrent: () => boolean) => Promise<void> }) {
  const [step, setStep] = useState(0), [name, setName] = useState(''), [description, setDescription] = useState(''), [icon, setIcon] = useState('');
  const [notificationMode, setNotificationMode] = useState('mentions'), [welcome, setWelcome] = useState(''), [welcomeEnabled, setWelcomeEnabled] = useState(true);
  const [template, setTemplate] = useState('blank'), [categories, setCategories] = useState<StarterCategory[]>([]), [channels, setChannels] = useState<DraftChannel[]>([]);
  const [policyEnabled, setPolicyEnabled] = useState(false), [policyLoaded, setPolicyLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [artBusy, setArtBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const [progress, setProgress] = useState(''), [created, setCreated] = useState(''), [uncertain, setUncertain] = useState(false);
  const lock = useRef(false), live = useRef(true), owner = useRef({ client: getMatrixClient(), account: accountArtworkOwner() });
  const receipts = useRef(new Map<string, ChannelCreationResult>()), serverId = useRef(''), serial = useRef(0), heading = useRef<HTMLHeadingElement>(null);
  const drafts = useRef(new Map<string, { categories: StarterCategory[]; channels: DraftChannel[] }>()), previousStep = useRef(0);
  const current = () => live.current && getMatrixClient() === owner.current.client && accountArtworkOwner() === owner.current.account;
  useEffect(() => {
    live.current = true;
    void readInstanceConfig().then(value => { if (current()) setPolicyEnabled(value.serverRolePolicy === true); }).catch(() => {
      if (current()) setError(new Error('Channel type support could not be checked. You can start with text channels and add other types later.'));
    }).finally(() => { if (current()) setPolicyLoaded(true); });
    return () => { live.current = false; };
  }, []);
  useEffect(() => { if (step !== previousStep.current) heading.current?.focus(); previousStep.current = step; }, [step]);
  const terms = terminology(naming), pending = busy || artBusy, included = channels.filter(channel => channel.included);
  const frozen = pending || !!created || uncertain;

  function chooseTemplate(id: string) {
    const value = serverTemplates[id]; if (!value || frozen) return;
    drafts.current.set(template, { categories, channels });
    const saved = drafts.current.get(id);
    setTemplate(id); setCategories(saved?.categories ?? value.categories.map(category => ({ ...category })));
    setChannels(saved?.channels ?? value.channels.map(channel => ({ ...channel, included: policyEnabled || channel.kind === 'text' })));
  }
  function updateChannel(id: string, patch: Partial<DraftChannel>) {
    setChannels(previous => previous.map(channel => channel.id === id ? { ...channel, ...patch } : channel));
  }
  function validate() {
    if (!current()) throw new Error('Your account changed. Reopen server creation.');
    if (!name.trim()) throw new Error('Give your server a name.');
    const checked = starterCategories(categories);
    validateStarterChannels(included, checked);
    if (included.some(channel => !Object.hasOwn(channelKinds, channel.kind) || !policyEnabled && channel.kind !== 'text')) throw new Error('Choose a channel type supported by this server.');
    return checked;
  }
  function next() {
    try { if (step === 1) validate(); else if (!name.trim()) throw new Error('Give your server a name.'); setError(null); setStep(step + 1); }
    catch (failure) { setError(failure); }
  }
  async function openCreated() {
    if (lock.current || !current()) return;
    lock.current = true; setBusy(true); setError(null);
    try { await onCreated(serverId.current, [...receipts.current.values()][0]?.roomId, current); if (current()) onClose(); }
    catch (failure) { if (current()) setError(failure); }
    finally { lock.current = false; if (current()) setBusy(false); }
  }
  async function create() {
    if (lock.current || uncertain || artBusy || !current()) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const checked = validate();
      if (!serverId.current) {
        setProgress('Creating your server…');
        try {
          const result = await matrixApi('createServer', { name: name.trim(), description, notificationMode, welcome, welcomeEnabled, categories: checked, icon });
          if (!current()) return;
          if (typeof result?.id !== 'string' || !/^![^\s/\\?#\x00-\x1f\x7f]{1,254}$/.test(result.id)) throw new Error('Server creation was not confirmed.');
          serverId.current = result.id; setCreated(result.id);
        } catch (failure) { if (current()) setUncertain(true); throw failure; }
      }
      for (const channel of included) {
        if (!current()) return;
        setProgress(`Setting up ${channel.name} (${[...receipts.current.values()].filter(value => !value.errors.length).length}/${included.length})…`);
        let receipt = receipts.current.get(channel.id);
        try {
          receipt = receipt ? receipt.errors.length ? await finishChannelCreation(receipt) : receipt : await createTypedChannel({ name: channel.name.trim(), description: channel.description, kind: channel.kind, serverId: serverId.current, categoryId: channel.category, members: [], slowModeSeconds: 0, icon: channelTemplates[channel.kind].icon });
        } catch (failure) { if (current() && /creation was not confirmed|valid channel ID/.test((failure as Error).message)) setUncertain(true); throw failure; }
        if (!current()) return;
        receipts.current.set(channel.id, receipt);
        if (receipt.errors.length) throw new Error(receipt.errors.join(' '));
      }
      await onCreated(serverId.current, [...receipts.current.values()][0]?.roomId, current); if (current()) onClose();
    } catch (failure) { if (current()) setError(failure); }
    finally { lock.current = false; if (current()) { setBusy(false); setProgress(''); } }
  }

  return <Dialog open={open} onOpenChange={value => { if (!value && !pending) onClose(); }}>
    <DialogContent className="tavern-dialog server-creation-dialog" showCloseButton={!pending}>
      <DialogHeader><DialogTitle>{created ? 'Finish your server' : `Create a ${terms.server}`}</DialogTitle><DialogDescription>A place for your people. Choose a starting point and make it yours.</DialogDescription></DialogHeader>
      <ol className="server-creation-steps" aria-label="Creation progress">{steps.map((title, index) => <li key={title} aria-current={step === index ? 'step' : undefined}><span aria-hidden="true">{step > index ? <Check size={16}/> : index + 1}</span>{title}</li>)}</ol>
      <form className="dialog-form server-creation-form" aria-busy={pending} onSubmit={event => { event.preventDefault(); if (pending) return; if (step < 2) next(); else void create(); }}>
        <h2 ref={heading} tabIndex={-1} className="server-creation-heading">{steps[step]}</h2>
        <fieldset disabled={frozen}>
          {step === 0 && <>
            <label>Name<input autoComplete="off" value={name} onChange={event => setName(event.target.value)} required maxLength={60} placeholder="Your community name"/></label>
            <label>Description <small>(optional)</small><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={200} rows={2} placeholder="What brings everyone together?"/></label>
            <details className="server-creation-icon"><summary>{icon ? 'Change server icon' : 'Add a server icon (optional)'}</summary><ImageEditor label="Server icon" value={icon} disabled={frozen} onBusyChange={setArtBusy} beforeUpload={() => { if (!current()) throw new Error('Your account changed. Reopen server creation.'); }} onChange={uri => { if (current()) setIcon(uri); }}/></details>
            <fieldset className="server-template-picker" disabled={!policyLoaded}><legend>Starting layout</legend><p className="login-help">You can edit every category and channel in the next step.</p><div className="server-template-grid">{Object.entries(serverTemplates).map(([id, value]) => <label className="server-template-card" key={id} data-selected={template === id}>
              <input type="radio" name="server-template" value={id} checked={template === id} onChange={() => chooseTemplate(id)}/><span><strong>{value.name}</strong><small>{value.description}</small></span>
            </label>)}</div>{!policyLoaded && <p role="status">Checking available channel types…</p>}</fieldset>
          </>}
          {step === 1 && <>
            <p className="login-help">Keep the channels you want, rename them or build your own layout. Categories group channels in the sidebar.</p>
            {!policyEnabled && <p role="status">This installation currently supports text channel creation here. Other types need the server role policy enabled by your administrator.</p>}
            <section aria-label="Starting categories"><h3>Categories</h3>{categories.map((category, index) => <div className="server-category-draft" key={category.id}>
              <label>Category {index + 1}<input value={category.name} maxLength={60} onChange={event => setCategories(previous => previous.map(item => item.id === category.id ? { ...item, name: event.target.value } : item))}/></label>
              <div className="server-draft-actions"><button type="button" className="secondary-button" aria-label={`Move category ${index + 1} up`} disabled={index === 0} onClick={() => setCategories(previous => { const next = [...previous]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}><ChevronUp size={16}/></button><button type="button" className="secondary-button" aria-label={`Move category ${index + 1} down`} disabled={index === categories.length - 1} onClick={() => setCategories(previous => { const next = [...previous]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return next; })}><ChevronDown size={16}/></button><button type="button" className="secondary-button" aria-label={`Remove category ${index + 1}`} onClick={() => { setCategories(previous => previous.filter(item => item.id !== category.id)); setChannels(previous => previous.map(item => item.category === category.id ? { ...item, category: '' } : item)); }}><Trash2 size={16}/></button></div>
            </div>)}<button type="button" className="secondary-button" disabled={categories.length >= 8} onClick={() => setCategories(previous => [...previous, { id: 'custom-' + ++serial.current, name: 'New category ' + serial.current, icon: '' }])}><Plus size={16}/> Add category</button><p className="login-help">Removing a category moves its channels to Ungrouped. Up to 8 starting categories.</p></section>
            <section aria-label="Starting channels"><h3>Channels <small>{included.length} included</small></h3>{channels.map((channel, index) => <article className="server-channel-draft" key={channel.id}>
              <label className="check-label"><input type="checkbox" checked={channel.included} disabled={!policyEnabled && channel.kind !== 'text'} onChange={event => updateChannel(channel.id, { included: event.target.checked })}/><span><strong>{channel.name || 'Unnamed channel'}</strong><small>{channelKinds[channel.kind]}{!policyEnabled && channel.kind !== 'text' ? ' · Unavailable' : ''}</small></span></label>
              <details><summary>Edit channel {index + 1}</summary><div className="server-channel-fields">
                <label>Channel {index + 1} name<input value={channel.name} maxLength={60} onChange={event => updateChannel(channel.id, { name: event.target.value })}/></label>
                <label>Channel {index + 1} type<select value={channel.kind} onChange={event => updateChannel(channel.id, { kind: event.target.value as ChannelKind })}>{Object.entries(channelKinds).map(([kind, label]) => <option key={kind} value={kind} disabled={!policyEnabled && kind !== 'text'}>{label}</option>)}</select></label><p className="login-help">{channelTemplates[channel.kind].guidance}</p>
                <label>Channel {index + 1} category<select value={channel.category} onChange={event => updateChannel(channel.id, { category: event.target.value })}><option value="">Ungrouped</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name || 'Unnamed category'}</option>)}</select></label>
                <label>Channel {index + 1} description<textarea value={channel.description} maxLength={500} rows={2} onChange={event => updateChannel(channel.id, { description: event.target.value })}/></label>
                <div className="server-draft-actions"><button type="button" className="secondary-button" disabled={index === 0} onClick={() => setChannels(previous => { const next = [...previous]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>Move up</button><button type="button" className="secondary-button" disabled={index === channels.length - 1} onClick={() => setChannels(previous => { const next = [...previous]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return next; })}>Move down</button><button type="button" className="secondary-button" onClick={() => setChannels(previous => previous.filter(item => item.id !== channel.id))}>Remove channel</button></div>
              </div></details>
            </article>)}<button type="button" className="secondary-button" disabled={channels.length >= 24} onClick={() => setChannels(previous => [...previous, { id: 'custom-' + ++serial.current, name: 'new-channel-' + serial.current, description: '', kind: 'text', category: categories[0]?.id || '', included: true }])}><Plus size={16}/> Add channel</button><p className="login-help">Up to 24 starting channels. Add more from the sidebar afterward.</p></section>
          </>}
          {step === 2 && <>
            <section className="server-creation-preview" aria-label="Server preview"><div className="server-preview-identity"><CommunityImage mxc={icon} name={name} size={48}/><div><h3>{name.trim()}</h3>{description && <p>{description}</p>}<small>{included.length} channels · {categories.length} categories · Invite-only</small></div></div>
              {[...categories, { id: '', name: 'Ungrouped', icon: '' }].map(category => { const entries = included.filter(channel => channel.category === category.id); return !category.id && !entries.length ? null : <div className="server-preview-category" key={category.id}><h4>{category.name}</h4>{entries.length ? <ul>{entries.map(channel => <li key={channel.id}><span aria-hidden="true">{channelTemplates[channel.kind].icon}</span><strong>{channel.name.trim()}</strong><small>{channelKinds[channel.kind]}</small></li>)}</ul> : <p>No starting channels in this category.</p>}</div>; })}
              {!included.length && <p>Your server starts empty. Use Add channel in the sidebar when you are ready.</p>}
            </section>
            <p className="login-help">You will be the owner. Channels start invite-only with encrypted messages. Channel names, descriptions and server artwork are visible to your homeserver. Voice and video only start when someone joins a call.</p>
            <details><summary>Welcome and notifications</summary><label>Default notifications<select value={notificationMode} onChange={event => setNotificationMode(event.target.value)}><option value="mentions">Mentions only</option><option value="all">All messages</option><option value="nothing">Nothing</option><option value="inherit">Use member preferences</option></select></label><label className="check-label"><input type="checkbox" checked={welcomeEnabled} onChange={event => setWelcomeEnabled(event.target.checked)}/>Show a welcome screen to new members</label>{welcomeEnabled && <label>Welcome message<textarea value={welcome} onChange={event => setWelcome(event.target.value)} maxLength={2000}/></label>}</details>
          </>}
        </fieldset>
        <ExperienceError error={error} draft={created ? 'Your server and completed channels are kept. Retry finishes the remaining setup.' : 'Your form entries are kept.'}/>
        {uncertain && <p role="status">Creation could not be confirmed. Check All channels and your server list before creating another copy. Automatic creation retries are paused.</p>}
        {!!receipts.current.size && <ul aria-label="Created channels">{[...receipts.current.values()].map(result => <li key={result.roomId}>{result.name}: {result.errors.length ? 'Needs remaining setup' : 'Ready'}</li>)}</ul>}
        <div className="server-creation-footer">{step > 0 && !created && !uncertain && <button type="button" className="secondary-button" disabled={pending} onClick={() => { setError(null); setStep(step - 1); }}>Back</button>}<button className="primary-button" disabled={pending || !name.trim() || uncertain || !policyLoaded}>{busy ? progress || 'Opening your server…' : artBusy ? 'Uploading icon…' : step < 2 ? 'Continue' : created ? 'Finish remaining setup' : `Create ${terms.server}`}</button>{created && <button type="button" className="secondary-button" disabled={pending} onClick={() => void openCreated()}>Open created server</button>}</div>
      </form>
    </DialogContent>
  </Dialog>;
}
