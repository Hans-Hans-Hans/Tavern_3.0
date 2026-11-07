import type { ReactNode } from 'react';
import { CircleHelp, Settings, ShieldCheck, UserRound } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export function ProfileMenu({ name, children, onSettings, onProfile, onPrivacy, onAbout, admin = false }: { name: string; children: ReactNode; onSettings: () => void; onProfile: () => void; onPrivacy: () => void; onAbout: () => void; admin?: boolean }) {
  return <DropdownMenu><DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger><DropdownMenuContent side='top' align='start' className='personal-menu'><DropdownMenuLabel>{name}</DropdownMenuLabel>
    <DropdownMenuItem onSelect={onProfile}><UserRound/>My profile</DropdownMenuItem>
    <DropdownMenuItem onSelect={onSettings}><Settings/>Personal settings</DropdownMenuItem>
    <DropdownMenuItem onSelect={onPrivacy}><ShieldCheck/>Privacy &amp; devices</DropdownMenuItem>
    <DropdownMenuItem onSelect={onAbout}><CircleHelp/>About Tavern</DropdownMenuItem>
    {admin && <><DropdownMenuSeparator/><DropdownMenuItem asChild><a href='/admin'><ShieldCheck/>Administration</a></DropdownMenuItem></>}
  </DropdownMenuContent></DropdownMenu>;
}
