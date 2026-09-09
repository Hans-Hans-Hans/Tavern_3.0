import { useEffect, useRef, useState } from 'react';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { canManageProfileMetadataPolicy, emptyProfileMetadataPolicy, profileBioLimits, profileStatusLimits, readServerProfileMetadataPolicy, saveProfileMetadataPolicy } from '@/lib/profile-metadata-policy';

export function ServerProfilePolicySettings({ serverId }: { serverId: string }) {
  const [previous, setPrevious] = useState(() => readServerProfileMetadataPolicy(serverId)), [value, setValue] = useState(() => previous || emptyProfileMetadataPolicy());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [, redraw] = useState(0);
  const lifetime = useRef(0), owner = useRef(getMatrixClient());
  const reload = () => { const current = readServerProfileMetadataPolicy(serverId); setPrevious(current); setValue(current || emptyProfileMetadataPolicy()); setError(''); setSaved(false); };
  useEffect(() => {
    const reset = () => { lifetime.current++; owner.current = getMatrixClient(); reload(); setBusy(false); };
    reset(); const unsubscribe = onMatrixUpdate(() => { if (owner.current !== getMatrixClient()) reset(); redraw(number => number + 1); });
    return () => { lifetime.current++; unsubscribe(); };
  }, [serverId]);
  if (!canManageProfileMetadataPolicy(serverId)) return error ? <p role="alert" className="connect-error">{error}</p> : null;
  return <section className="product-section"><h3>Server profile rules</h3>
    <p>Limit links, custom fields, bio and status in the profiles members publish to this server, its channels and their private discussions. Global account profiles stay independent.</p>
    <p>These rules cover structured profile metadata. They do not scan message content, images or web addresses typed into free text. Older profile events remain readable through Matrix; Tavern applies the current limits when displaying profiles.</p>
    {!previous && <p role="alert">Saved profile rules are invalid. Review and save a replacement.</p>}
    <form className="dialog-form" onSubmit={async event => {
      event.preventDefault(); const version = lifetime.current, client = getMatrixClient(), current = () => version === lifetime.current && client === getMatrixClient();
      setBusy(true); setError(''); setSaved(false);
      try { const next = await saveProfileMetadataPolicy(serverId, value, previous); if (current()) { setPrevious(next); setValue(next); setSaved(true); } }
      catch (failure) { if (current()) setError((failure as Error).message); }
      finally { if (current()) setBusy(false); }
    }}><fieldset disabled={busy}>
      <label className="checkbox-row"><input type="checkbox" checked={value.enabled} onChange={event => setValue(value => ({ ...value, enabled: event.target.checked }))}/>Enforce server profile rules</label>
      <fieldset disabled={!value.enabled}>
        <label className="checkbox-row"><input type="checkbox" checked={value.allowLinks} onChange={event => setValue(value => ({ ...value, allowLinks: event.target.checked }))}/>Allow profile links</label>
        <label className="checkbox-row"><input type="checkbox" checked={value.allowCustomFields} onChange={event => setValue(value => ({ ...value, allowCustomFields: event.target.checked }))}/>Allow custom profile fields</label>
        <label>Maximum bio length<select value={value.maxBioLength} onChange={event => setValue(value => ({ ...value, maxBioLength: Number(event.target.value) }))}>{profileBioLimits.map(length => <option key={length} value={length}>{length ? `${length} characters` : 'Bio disabled'}</option>)}</select></label>
        <label>Maximum status length<select value={value.maxStatusLength} onChange={event => setValue(value => ({ ...value, maxStatusLength: Number(event.target.value) }))}>{profileStatusLimits.map(length => <option key={length} value={length}>{length ? `${length} characters` : 'Status disabled'}</option>)}</select></label>
      </fieldset>
      <button className="primary-button">Save profile rules</button><button className="secondary-button" type="button" onClick={reload}>Reload profile rules</button>
    </fieldset></form>{saved && <p role="status">Profile rules saved.</p>}{error && <p role="alert" className="connect-error">{error}</p>}
  </section>;
}
