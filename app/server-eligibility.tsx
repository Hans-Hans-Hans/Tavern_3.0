import { useEffect, useRef, useState } from 'react';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { accountAgeChoices, canManageServerEligibility, emptyServerEligibility, readServerEligibility, saveServerEligibility } from '@/lib/server-eligibility';

const ageLabels: Record<number, string> = { 0: 'No minimum', 300: '5 minutes', 3600: '1 hour', 86400: '1 day', 604800: '1 week' };
export function ServerEligibilitySettings({ serverId }: { serverId: string }) {
  const [previous, setPrevious] = useState(() => readServerEligibility(serverId));
  const [value, setValue] = useState(() => previous || emptyServerEligibility());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [, redraw] = useState(0);
  const lifetime = useRef(0), owner = useRef(getMatrixClient());
  const reload = () => { const current = readServerEligibility(serverId); setPrevious(current); setValue(current || emptyServerEligibility()); setError(''); setSaved(false); };
  useEffect(() => {
    const reset = () => { lifetime.current++; owner.current = getMatrixClient(); reload(); setBusy(false); };
    reset();
    const unsubscribe = onMatrixUpdate(() => { if (owner.current !== getMatrixClient()) reset(); redraw(value => value + 1); });
    return () => { lifetime.current++; unsubscribe(); };
  }, [serverId]);
  if (!canManageServerEligibility(serverId)) return error ? <p role="alert" className="connect-error">{error}</p> : null;
  return <section className="product-section"><h3>Server verification</h3>
    <p>Choose the account requirements for joining this server and participating in its channels. The server checks verified email and the original account creation date when members join, post or enter a call.</p>
    <p>Private discussions inherit the requirements of their source channel. Raising a requirement can pause participation for existing members until they qualify. It does not remove their membership or previously accessible history. A server’s creator is exempt from that server’s own requirements.</p>
    {!previous && <p role="alert">Saved verification settings are invalid. Review and save a replacement.</p>}
    <form className="dialog-form" onSubmit={async event => {
      event.preventDefault(); const version = lifetime.current, client = getMatrixClient();
      const current = () => version === lifetime.current && client === getMatrixClient();
      setBusy(true); setError(''); setSaved(false);
      try { const next = await saveServerEligibility(serverId, value, previous); if (current()) { setPrevious(next); setValue(next); setSaved(true); } }
      catch (failure) { if (current()) setError((failure as Error).message); }
      finally { if (current()) setBusy(false); }
    }}><fieldset disabled={busy}>
      <label className="checkbox-row"><input type="checkbox" checked={value.requireVerifiedEmail} onChange={event => setValue(value => ({ ...value, requireVerifiedEmail: event.target.checked }))}/>Require a verified email address</label>
      <label>Minimum account age<select value={value.minimumAccountAgeSeconds} onChange={event => setValue(value => ({ ...value, minimumAccountAgeSeconds: Number(event.target.value) }))}>{accountAgeChoices.map(age => <option key={age} value={age}>{ageLabels[age]}</option>)}</select></label>
      <button className="primary-button">Save verification settings</button><button className="secondary-button" type="button" onClick={reload}>Reload verification settings</button>
    </fieldset></form>{saved && <p role="status">Verification settings saved.</p>}{error && <p role="alert" className="connect-error">{error}</p>}
  </section>;
}
