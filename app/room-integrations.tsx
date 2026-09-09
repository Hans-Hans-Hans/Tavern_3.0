import { useEffect, useState } from 'react';
import { onMatrixUpdate } from '@/lib/matrix';
import { roomWebhookLocations } from '@/lib/room-integrations';
import { AdminIntegrations } from './admin-integrations';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function RoomIntegrations({ roomId, inline = false }: { roomId: string; inline?: boolean }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(''), [, refresh] = useState(0);
  useEffect(() => onMatrixUpdate(() => refresh(value => value + 1)), []);
  useEffect(() => { setOpen(false); setSelected(''); }, [roomId]);
  const locations = roomWebhookLocations(roomId), current = locations.find(room => room.id === selected) || locations[0];
  if (!locations.length) return null;
  const content = <>{locations.length > 1 && <label>Webhook channel<select value={current.id} onChange={event => setSelected(event.target.value)}>{locations.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>}<AdminIntegrations key={current.id} roomId={current.id}/></>;
  if (inline) return content;
  return <section className='product-section'><h3>Channel integrations</h3><button className='secondary-button' onClick={() => setOpen(true)}>Manage webhooks</button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className='tavern-dialog settings-dialog'><DialogHeader><DialogTitle>Manage channel webhooks</DialogTitle><DialogDescription>Manage incoming hooks only in channels where your current role and room permissions allow it.</DialogDescription></DialogHeader>
      {content}
    </DialogContent></Dialog>
  </section>;
}
