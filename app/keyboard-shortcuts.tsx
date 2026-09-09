import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { matchTavernShortcut, nextUnreadConversation, normalizeUnreadShortcut, type UnreadConversation, type UnreadShortcut } from '@/lib/keyboard-shortcuts';
import './keyboard-shortcuts.css';
export function KeyboardShortcuts({ currentRoomId, conversations, onSelectRoom, userId = '', enterToSend = true }: { currentRoomId: string; conversations: UnreadConversation[]; onSelectRoom: (roomId: string) => void; userId?: string; enterToSend?: boolean }) {
  const [open, setOpen] = useState(false), [binding, setBinding] = useState<UnreadShortcut>('alt'), [error, setError] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null), key = 'tavern.shortcuts:' + userId;
  useEffect(() => { try { setBinding(normalizeUnreadShortcut(localStorage.getItem(key))); } catch { setBinding('alt'); } }, [key]);
  useEffect(() => {
    const show = () => { if (!open) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setOpen(true); };
    const handle = (event: KeyboardEvent) => {
      const action = matchTavernShortcut(event, binding); if (!action) return;
      if (action === 'reference') { event.preventDefault(); show(); return; }
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') || event.target instanceof HTMLSelectElement || event.target instanceof HTMLElement && event.target.getAttribute('role') === 'combobox') return;
      event.preventDefault(); const roomId = nextUnreadConversation(conversations, currentRoomId, action === 'previous-unread' ? -1 : 1);
      if (roomId) onSelectRoom(roomId); else toast('No other unread conversations');
    };
    window.addEventListener('tavern:keyboard-shortcuts', show); window.addEventListener('keydown', handle);
    return () => { window.removeEventListener('tavern:keyboard-shortcuts', show); window.removeEventListener('keydown', handle); };
  }, [binding, currentRoomId, conversations, onSelectRoom, open]);
  const navigationKeys = binding === 'alt-shift' ? 'Alt + Shift + ' : 'Alt + ';
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent className='tavern-dialog keyboard-reference' onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); }}><DialogHeader><DialogTitle>Keyboard shortcuts</DialogTitle><DialogDescription>Use Ctrl on Windows and Linux, or Command on macOS. Unread navigation follows your conversation order and skips muted conversations.</DialogDescription></DialogHeader><table><thead><tr><th>Action</th><th>Shortcut</th></tr></thead><tbody>{[
    ['Switch conversation or find a person', 'Ctrl / ⌘ + K'], ['Command palette', 'Ctrl / ⌘ + Shift + P'], ['Search messages', 'Ctrl / ⌘ + F'], ['This reference', 'Ctrl / ⌘ + /'], ['Previous unread conversation', binding === 'disabled' ? 'Disabled' : navigationKeys + '↑'], ['Next unread conversation', binding === 'disabled' ? 'Disabled' : navigationKeys + '↓'], ['Close menu or dialog; cancel an edit', 'Esc'], ['Choose a menu item', '↑ / ↓, then Enter'], ['Send message', enterToSend ? 'Enter' : 'Ctrl / ⌘ + Enter'], ['Insert a new line', enterToSend ? 'Shift + Enter' : 'Enter'], ['Edit your last message with an empty composer', '↑'],
  ].map(([label, shortcut]) => <tr key={label}><td>{label}</td><td><kbd>{shortcut}</kbd></td></tr>)}</tbody></table><label className='product-field'><span>Unread navigation shortcut</span><select value={binding} onChange={event => { const next = normalizeUnreadShortcut(event.target.value); setBinding(next); setError(''); try { localStorage.setItem(key, next); } catch { setError('This setting changed for this tab, but browser storage is unavailable.'); } }}><option value='alt'>Alt + Up / Down</option><option value='alt-shift'>Alt + Shift + Up / Down</option><option value='disabled'>Disabled</option></select></label><p className='login-help'>This device setting can avoid conflicts with your operating system or assistive technology. Navigation does not run during text composition or while another menu or dialog is open.</p>{error && <p role='alert' className='connect-error'>{error}</p>}</DialogContent></Dialog>;
}
