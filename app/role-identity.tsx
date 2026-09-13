import { useEffect, useState, type ReactNode } from 'react';
import { Crown } from 'lucide-react';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { readRolePolicy } from '@/lib/roles';
import { memberRolePresentation } from '@/lib/role-presentation';
import { RoleIcon } from './role-icon';
import './role-identity.css';

function useIdentity(serverId: string | undefined, userId: string) {
  const [, redraw] = useState(0);
  useEffect(() => serverId ? onMatrixUpdate(() => redraw(value => value + 1)) : undefined, [serverId]);
  const server = serverId ? getMatrixClient()?.getRoom(serverId) : null;
  const joined = server?.isSpaceRoom?.() && server.getMyMembership?.() === 'join' && server.getMember?.(userId)?.membership === 'join';
  return memberRolePresentation(joined && serverId ? readRolePolicy(serverId) : null, userId);
}

export function ServerRoleName({ serverId, userId, children, showOwner = false }: { serverId?: string; userId: string; children: ReactNode; showOwner?: boolean }) {
  const identity = useIdentity(serverId, userId);
  return <span className='server-role-name'><span className='server-role-name-text' style={{ color: identity.color || undefined }}>{children}</span>
    {identity.iconRole && <RoleIcon role={identity.iconRole} />}
    {showOwner && identity.owner && <Crown size={13} role='img' aria-label='Server owner' className='server-role-owner'/>}
  </span>;
}

export function ServerRoleBadges({ serverId, userId }: { serverId: string; userId: string }) {
  const identity = useIdentity(serverId, userId);
  if (!identity.badges.length && !identity.owner) return null;
  return <div className='server-role-badges' aria-label='Server roles'>
    {identity.owner && <span className='server-role-badge'><Crown size={13}/>Owner</span>}
    {identity.badges.map(role => <span className='server-role-badge' key={role.id}><span className='server-role-badge-dot' style={{ backgroundColor: role.color || 'var(--muted-foreground)' }}/><RoleIcon role={role} decorative />{role.name}</span>)}
  </div>;
}
