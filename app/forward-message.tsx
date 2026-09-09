import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { discardMatrixFile, getMatrixClient, matrixApi, matrixFileBlob, uploadMatrixFile } from '@/lib/matrix';
import { messagePermissions } from '@/lib/interactions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { MediaAttachment } from './media-viewer';
export function ForwardMessage({ message, onClose }: { message: { id: string; conversation_id: string; author_name: string; body: string; attachments: MediaAttachment[] }; onClose: () => void }) {
  const [destination, setDestination] = useState(''), [query, setQuery] = useState(''), [withFiles, setWithFiles] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState('');
  const pending = useRef<string[]>([]), nonce = useRef(crypto.randomUUID()), attempted = useRef(false), uploaded = useRef(false);
  const client = getMatrixClient(), rooms = client?.getRooms().filter(room => !room.isSpaceRoom() && room.getMyMembership() === 'join' && messagePermissions(room.roomId, client.getUserId()!).send) || [];
  useEffect(() => () => pending.current.forEach(discardMatrixFile), []);
  const source = location.origin + '/#room=' + encodeURIComponent(message.conversation_id) + '&event=' + encodeURIComponent(message.id);
  async function forward() {
    if (!destination || busy) return; setBusy(true); setError(''); attempted.current = true;
    try {
      if (withFiles && !uploaded.current) { for (let index = pending.current.length; index < message.attachments.length; index++) { const attachment = message.attachments[index]; setProgress('Preparing ' + attachment.name); const blob = await matrixFileBlob(attachment); const file = await uploadMatrixFile(new File([blob], attachment.name, { type: blob.type }), destination); pending.current.push(file.id); } uploaded.current = true; }
      setProgress('Sending forwarded message');
      const body = 'Forwarded from ' + message.author_name.slice(0,100) + '\n' + message.body.slice(0, 6500).split('\n').map(line => '> ' + line).join('\n').slice(0,6000) + '\n\n' + (source.length<=1500?source:'');
      await matrixApi('send', { conversation: destination, body, suppressMentions:true, attachments: pending.current, nonce: nonce.current }); pending.current = []; toast.success('Message forwarded'); onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); setProgress(''); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className='tavern-dialog'><DialogHeader><DialogTitle>Forward message</DialogTitle><DialogDescription>Send a copy as yourself. Everyone in the destination can read the forwarded content.</DialogDescription></DialogHeader><blockquote className='forward-preview'>{message.body.slice(0, 500)}</blockquote><form className='dialog-form' onSubmit={event => { event.preventDefault(); void forward(); }}><fieldset disabled={busy || attempted.current}><label>Find a conversation<input type='search' value={query} onChange={e => setQuery(e.target.value)}/></label><label>Destination<select required value={destination} onChange={e => setDestination(e.target.value)}><option value=''>Choose a conversation</option>{rooms.filter(room => room.roomId === destination || room.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(room => <option value={room.roomId} key={room.roomId}>{room.name}</option>)}</select></label>{message.attachments.length > 0 && <label className='check-label'><input type='checkbox' checked={withFiles} onChange={e => setWithFiles(e.target.checked)}/>Include {message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}</label>}</fieldset>{!rooms.length && <p>You have no conversations where you can send messages.</p>}{withFiles && <p>Attachments are copied and encrypted for the destination when that conversation uses encryption.</p>}{attempted.current && error && <p>The destination is kept for a safe retry. Close this dialog to start another forward.</p>}<button className='primary-button' disabled={busy || !destination}>{busy ? progress || 'Forwarding…' : error ? 'Retry forward' : 'Forward message'}</button></form>{error && <p className='connect-error' role='alert'>{error}</p>}</DialogContent></Dialog>;
}
