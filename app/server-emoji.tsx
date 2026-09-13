import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ImagePlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { onMatrixUpdate } from '@/lib/matrix';
import { cropProfileImage } from '@/lib/community';
import { addServerEmoji, canManageServerEmoji, filterServerEmoji, readServerEmoji, removeServerEmoji, renameServerEmoji, tokenizeServerEmoji, type ServerEmoji } from '@/lib/server-emoji';
import { CommunityImage } from './community-settings';
import { useRoleEditorOwner } from './role-editor-owner';
import { ExperienceError } from './experience-error';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import './server-emoji.css';

function useEmojis(serverId?: string) { const [, redraw] = useState(0); useEffect(() => onMatrixUpdate(() => redraw(v => v + 1)), []); return readServerEmoji(serverId); }
export function ServerEmojiManager({ serverId }: { serverId: string }) {
  return <ServerEmojiEditor key={serverId} serverId={serverId} />;
}
function ServerEmojiEditor({ serverId }: { serverId: string }) {
  const { current } = useRoleEditorOwner(serverId), emojis = useEmojis(serverId);
  const [name, setName] = useState(''), [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState(''), fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), lock = useRef(false), [error, setError] = useState<unknown>(null);
  const [remove, setRemove] = useState<ServerEmoji | null>(null), [renaming, setRenaming] = useState<ServerEmoji | null>(null);
  const [newName, setNewName] = useState(''), [query, setQuery] = useState('');
  useEffect(() => {
    let active = true, url = '';
    setPreview('');
    if (file) void cropProfileImage(file).then(blob => {
      if (active && current()) { url = URL.createObjectURL(blob); setPreview(url); }
    }).catch(error => { if (active && current()) setError(error); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [file]);
  async function run(action: () => Promise<unknown>, complete: () => void, message: string) {
    if (lock.current || !current() || !canManageServerEmoji(serverId)) return;
    lock.current = true; setBusy(true); setError(null);
    try { await action(); if (current()) { complete(); toast.success(message); } }
    catch (error) { if (current()) setError(error); }
    finally { lock.current = false; if (current()) setBusy(false); }
  }
  function clearImage() { setFile(null); setPreview(''); if (fileInput.current) fileInput.current.value = ''; }
  if (!current()) return <p role="status">This emoji editor is no longer current. Reopen server settings.</p>;
  if (!canManageServerEmoji(serverId)) return <p role="status">You need permission to manage this server's emoji.</p>;
  const shown = filterServerEmoji(emojis, query);
  return <section className="channel-admin server-emoji-manager">
    <div className="server-emoji-heading"><div><h3>Server emoji</h3><p className="login-help">Give your conversations something of their own. Type :name: in a message or choose an emoji when reacting.</p></div><span className="server-emoji-count">{emojis.length} / 100 used</span></div>
    <form className="dialog-form server-emoji-upload" onSubmit={event => {
      event.preventDefault(); if (!file || !preview) return;
      void run(() => addServerEmoji(serverId, name, file, { isCurrent: current }), () => { setName(''); clearImage(); }, 'Emoji added');
    }}>
      <div className="server-emoji-preview">{preview ? <img src={preview} alt="Emoji upload preview" width={72} height={72} /> : <ImagePlus size={32} aria-hidden="true" />}<small>{name ? ':' + name + ':' : 'Your emoji'}</small></div>
      <div className="server-emoji-upload-fields">
        <label>Emoji name<input required pattern="[a-z0-9_-]{1,32}" maxLength={32} value={name} placeholder="tavern_cheers" onChange={event => setName(event.target.value.toLowerCase())} disabled={busy} /></label>
        <label>Emoji image<input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={event => {
          const next = event.target.files?.[0] || null; setError(null); setPreview(''); setFile(next);
          if (!name && next) setName(next.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 32));
        }} /></label>
        <p className="login-help">PNG, JPEG, WebP or GIF up to 10 MB. Images are cropped to a square. GIFs become still images.</p>
        <div className="product-actions"><button className="primary-button" disabled={busy || !file || !preview || emojis.length >= 100}><Plus size={16} />{busy ? 'Saving…' : 'Upload emoji'}</button>{file && <button className="secondary-button" type="button" disabled={busy} onClick={() => { clearImage(); setError(null); }}>Clear image</button>}</div>
        {emojis.length >= 100 && <p role="status">All emoji slots are in use. Remove an emoji to make room.</p>}
      </div>
    </form>
    {!renaming && !remove && <ExperienceError error={error} context="save" draft="Your selection is kept so you can correct it and retry." />}
    <label className="server-emoji-search">Find an emoji<input type="search" aria-label="Search managed emoji" placeholder="Search names or previous names" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="server-emoji-collection" aria-label="Server emoji collection">{shown.map(emoji => <div className="server-emoji-row" key={emoji.name}>
      <CommunityImage mxc={emoji.uri} name={':' + emoji.name + ':'} size={36} />
      <div className="server-emoji-row-name"><strong>:{emoji.name}:</strong>{!!emoji.aliases?.length && <small>Also works: {emoji.aliases.map(alias => ':' + alias + ':').join(' ')}</small>}</div>
      <button type="button" aria-label={'Rename ' + emoji.name} title="Rename emoji" disabled={busy} onClick={() => { setRenaming(emoji); setNewName(emoji.name); setError(null); }}><Pencil size={18} /></button>
      <button type="button" aria-label={'Remove ' + emoji.name} title="Remove emoji" disabled={busy} onClick={() => { setRemove(emoji); setError(null); }}><Trash2 size={18} /></button>
    </div>)}</div>
    {!shown.length && <p role="status" className="server-emoji-empty">{emojis.length ? 'No emoji match that name. Try a previous name or clear your search.' : 'Your server has no custom emoji yet. Add the first one above.'}</p>}
    <Dialog open={!!renaming} onOpenChange={open => { if (!open && !busy) { setRenaming(null); setError(null); } }}>
      <DialogContent className="tavern-dialog"><DialogHeader><DialogTitle>Rename emoji</DialogTitle><DialogDescription>The image stays the same. Up to eight previous names continue to work in messages.</DialogDescription></DialogHeader>
        {renaming && <CommunityImage mxc={renaming.uri} name={':' + renaming.name + ':'} size={48} />}
        <form className="dialog-form" onSubmit={event => {
          event.preventDefault(); if (!renaming) return;
          void run(() => renameServerEmoji(serverId, renaming.name, newName, { isCurrent: current, expectedUri: renaming.uri }), () => setRenaming(null), 'Emoji renamed');
        }}>
          <label>New emoji name<input autoFocus required pattern="[a-z0-9_-]{1,32}" maxLength={32} value={newName} disabled={busy} onChange={event => setNewName(event.target.value.toLowerCase())} /></label>
          <button className="primary-button" disabled={busy || newName.trim() === renaming?.name}>Save emoji name</button>
          <ExperienceError error={error} draft="Your new name is kept. Review the current emoji before retrying." />
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={!!remove} onOpenChange={open => { if (!open && !busy) { setRemove(null); setError(null); } }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove :{remove?.name}:?</AlertDialogTitle><AlertDialogDescription>This removes the emoji and its previous names from the server picker. Existing messages and uploaded media may retain copies.</AlertDialogDescription></AlertDialogHeader>
        {remove && <CommunityImage mxc={remove.uri} name={':' + remove.name + ':'} size={48} />}
        <ExperienceError error={error} />
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={event => {
          event.preventDefault(); if (!remove) return;
          void run(() => removeServerEmoji(serverId, remove.name, { isCurrent: current, expectedUri: remove.uri }), () => setRemove(null), 'Emoji removed');
        }}>Remove emoji</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
export function ServerEmojiPicker({ serverId, onPick }: { serverId?: string; onPick: (emoji: ServerEmoji) => void }) { const emojis = useEmojis(serverId), [query, setQuery] = useState(''); if (!emojis.length) return null; return <div className="community-emoji-picker"><input aria-label="Search server emoji" type="search" placeholder="Search server emoji" value={query} onChange={e => setQuery(e.target.value)} /><div>{filterServerEmoji(emojis, query).map(emoji => <button type="button" key={emoji.name} aria-label={':' + emoji.name + ':'} title={':' + emoji.name + ':'} onClick={() => onPick(emoji)}><CommunityImage mxc={emoji.uri} name={emoji.name} size={28} /></button>)}</div></div>; }
export function ServerEmojiText({ text, serverId, renderText }: { text: string; serverId?: string; renderText?: (text: string) => ReactNode }) { const emojis = useEmojis(serverId); return <>{tokenizeServerEmoji(text, emojis).map((part, i) => <span key={i}>{'text' in part ? renderText ? renderText(part.text) : part.text : <span className="community-inline-emoji" title={':' + part.emoji.name + ':'}><CommunityImage mxc={part.emoji.uri} name={':' + part.emoji.name + ':'} size={24} /></span>}</span>)}</>; }
