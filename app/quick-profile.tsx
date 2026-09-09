import { useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { getMatrixClient } from '@/lib/matrix';
import { readMemberProfile, readMemberProfileContext } from '@/lib/community';
import { CommunityImage } from './community-settings';
import { ServerRoleBadges } from './server-roles';
export function QuickProfile({ children, roomId, userId, serverId, onOpenFull, onMessage }: { children: ReactNode; roomId: string; userId: string; serverId?: string; onOpenFull: () => void; onMessage?: () => void }) {
  const [open, setOpen] = useState(false);
  const profile = open ? readMemberProfile(roomId, userId, serverId) : null, context = open ? readMemberProfileContext(roomId, userId) : null;
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild>{children}</PopoverTrigger><PopoverContent className="quick-profile" style={profile?.accent ? { borderColor: profile.accent } : undefined}>{profile && <><CommunityImage mxc={profile.avatar} name={profile.name || userId} size={64}/><h3>{profile.name || userId}</h3><small>{userId}</small>{serverId && <ServerRoleBadges serverId={serverId} userId={userId}/>}<p>{profile.statusEmoji} {profile.status}</p>{profile.bio && <p>{profile.bio.slice(0, 180)}{profile.bio.length > 180 ? '…' : ''}</p>}{context?.mutualServers.length ? <small>{context.mutualServers.length} shared server{context.mutualServers.length === 1 ? '' : 's'}</small> : null}<div className="inline-actions"><button className="secondary-button" onClick={() => { setOpen(false); onOpenFull(); }}>Full profile</button>{onMessage && userId !== getMatrixClient()?.getUserId() && <button className="secondary-button" onClick={() => { setOpen(false); onMessage(); }}>Message</button>}</div></>}</PopoverContent></Popover>;
}
