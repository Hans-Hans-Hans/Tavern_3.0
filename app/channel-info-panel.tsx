import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

export function ChannelInfoPanel({ open, onOpenChange, name, children }: { open: boolean; onOpenChange: (open: boolean) => void; name: string; children: ReactNode }) {
  const [drawer, setDrawer] = useState(() => matchMedia('(max-width: 1100px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width: 1100px)'), update = () => setDrawer(media.matches);
    update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update);
  }, []);
  const restoreFocus = () => document.querySelector<HTMLButtonElement>('[aria-controls="channel-information-panel"]')?.focus();
  if (drawer) return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent onCloseAutoFocus={event=>{event.preventDefault();restoreFocus();}} className='channel-info-drawer' id='channel-information-panel'><SheetHeader><SheetTitle>Channel information</SheetTitle><SheetDescription>{name} — members and conversation resources.</SheetDescription></SheetHeader><div className='channel-info-content'>{children}</div></SheetContent></Sheet>;
  return open ? <aside className='channel-overview' id='channel-information-panel' aria-label='Channel information'><div className='overview-title'><span>CHANNEL INFORMATION</span><button type='button' className='icon-button' aria-label='Close channel information' onClick={() => {onOpenChange(false);restoreFocus();}}><X size={18}/></button></div>{children}</aside> : null;
}
