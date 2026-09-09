import { useEffect, useRef, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { onMatrixUpdate } from '@/lib/matrix';
import { appearanceOwner, isAppearanceOwner, applyAppearance, normalizeAppearance, readAppearance, saveAppearance, type AppearancePreferences } from '@/lib/appearance';
import './appearance.css';
export function AppearanceSettings() {
  const [preferences, setPreferences] = useState(readAppearance), [saving, setSaving] = useState(false), [error, setError] = useState(''), saved = useRef(preferences), editing = useRef(false), mounted = useRef(true), viewOwner = useRef(appearanceOwner());
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      const changed = !isAppearanceOwner(viewOwner.current);
      if (changed) { viewOwner.current = appearanceOwner(); editing.current = false; setSaving(false); setError(''); }
      if (changed || !editing.current) { const value = readAppearance(); saved.current = value; setPreferences(value); }
    };
    const stop = onMatrixUpdate(refresh);
    window.addEventListener('tavern:signout', refresh);
    return () => { mounted.current = false; stop(); window.removeEventListener('tavern:signout', refresh); };
  }, []);
  const renderedOwner = viewOwner.current;
  function currentView() {
    if (!mounted.current) return false;
    if (isAppearanceOwner(renderedOwner)) return true;
    viewOwner.current = appearanceOwner(); const value = readAppearance();
    saved.current = value; editing.current = false; setSaving(false);
    setPreferences(value); applyAppearance(value); setError('Your account changed. Choose this setting again.'); return false;
  }
  function preview(change: Partial<AppearancePreferences>) {
    if (!currentView()) return;
    const next = normalizeAppearance({ ...preferences, ...change }); setPreferences(next); applyAppearance(next);
  }
  async function update(change: Partial<AppearancePreferences>) {
    if (!currentView() || saving) return;
    const owner = appearanceOwner(), current = () => mounted.current && isAppearanceOwner(owner);
    if (!current()) return;
    const next = normalizeAppearance({ ...preferences, ...change });
    if (JSON.stringify(next) === JSON.stringify(saved.current)) return;
    setPreferences(next); applyAppearance(next); setSaving(true); setError('');
    try { const value = await saveAppearance(change); if (current()) { saved.current = value; setPreferences(value); } }
    catch (e) { if (current()) { setPreferences(saved.current); applyAppearance(saved.current); setError((e as Error).message); } }
    finally { if (current()) setSaving(false); }
  }
  return <section className="settings-section appearance-settings"><h3>Theme</h3><div className="appearance-theme-options" role="group" aria-label="Theme">{([{ id: 'system', name: 'Use system', Icon: Monitor }, { id: 'light', name: 'Daylight', Icon: Sun }, { id: 'dark', name: 'After hours', Icon: Moon }] as const).map(({ id, name, Icon }) => <button type="button" key={id} disabled={saving} aria-pressed={preferences.theme === id} onClick={() => void update({ theme: id })}><Icon size={18} />{name}</button>)}</div><div className="dialog-form"><label>Interface density<select value={preferences.density} disabled={saving} onChange={e => void update({ density: e.target.value as AppearancePreferences['density'] })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label>Message spacing<select value={preferences.messageSpacing} disabled={saving} onChange={e => void update({ messageSpacing: e.target.value as AppearancePreferences['messageSpacing'] })}><option value="auto">Follow Compact messages</option><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="spacious">Spacious</option></select></label><label>Font<select value={preferences.font} disabled={saving} onChange={e => void update({ font: e.target.value as AppearancePreferences['font'] })}><option value="system">System sans serif</option><option value="readable">Readable serif</option><option value="monospace">Monospace</option></select></label><label>Chat text size: {Math.round(preferences.chatScale * 100)}%<input type="range" min="0.85" max="1.5" step="0.05" value={preferences.chatScale} disabled={saving} onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; if (preferences.chatScale !== saved.current.chatScale) void update({ chatScale: preferences.chatScale }); }} onChange={e => preview({ chatScale: Number(e.target.value) })} onPointerUp={() => void update({ chatScale: preferences.chatScale })} onKeyUp={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) void update({ chatScale: preferences.chatScale }); }} aria-label="Chat text size" /></label><label>Interface color saturation: {Math.round(preferences.saturation * 100)}%<input type="range" min="0" max="1" step="0.1" value={preferences.saturation} disabled={saving} onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; if (preferences.saturation !== saved.current.saturation) void update({ saturation: preferences.saturation }); }} onChange={e => preview({ saturation: Number(e.target.value) })} onPointerUp={() => void update({ saturation: preferences.saturation })} onKeyUp={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) void update({ saturation: preferences.saturation }); }} aria-label="Interface color saturation" /></label></div><div className="setting-row"><span><strong>Show member list</strong><small>Display channel members and details when there is enough room.</small></span><Switch checked={preferences.memberList} disabled={saving} aria-label="Show member list" onCheckedChange={memberList => void update({ memberList })} /></div><div className="setting-row"><span><strong>Reduce motion</strong><small>Your operating system preference is always respected.</small></span><Switch checked={preferences.reducedMotion === 'always'} disabled={saving} aria-label="Always reduce motion" onCheckedChange={checked => void update({ reducedMotion: checked ? 'always' : 'system' })} /></div><div className="appearance-preview"><strong>Preview</strong><p>This is how a message will look in your conversations.</p><div className="appearance-message-preview" aria-label="Message spacing preview"><div className="message"><span>A message in your conversation.</span></div><div className="message"><span>A reply with your chosen spacing.</span></div></div><small>Preferences sync across your signed-in devices. Images and video keep their original colors.</small></div>{error && <p className="connect-error" role="alert">{error}</p>}</section>;
}
