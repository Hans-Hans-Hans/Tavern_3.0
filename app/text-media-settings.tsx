import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { saveTextMedia, useTextMedia, type TextMediaPreferences } from '@/lib/text-media';
export function TextMediaSettings() {
  const preferences = useTextMedia(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function change(value: Partial<TextMediaPreferences>) { setBusy(true); setError(''); try { await saveTextMedia(value); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <section className="settings-section"><h3>Text & media</h3><div className="setting-row"><span><strong>Enter sends a message</strong><small>Shift+Enter always adds a new line. When off, use Ctrl+Enter or Cmd+Enter to send.</small></span><Switch aria-label="Enter sends a message" checked={preferences.enterToSend} disabled={busy} onCheckedChange={enterToSend => void change({ enterToSend })} /></div><div className="setting-row"><span><strong>Show image thumbnails</strong><small>Load small previews shared in conversations. Opening an attachment loads its original file.</small></span><Switch aria-label="Show image thumbnails" checked={preferences.inlineImages} disabled={busy} onCheckedChange={inlineImages => void change({ inlineImages })} /></div><p>Your choices sync to your signed-in devices. Link previews always require a separate click.</p>{error && <p role="alert" className="connect-error">{error}</p>}</section>;
}
