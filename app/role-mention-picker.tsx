import { useEffect, useState } from 'react';
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { roleMentionChoices } from '@/lib/role-mentions';
import { roleMentionToken } from '@/lib/role-mention-token';

export function RoleMentionPicker({ roomId, disabled, onSelect }: { roomId: string; disabled?: boolean; onSelect: (token: string) => void }) {
  const [, redraw] = useState(0), client = getMatrixClient(), owner = accountArtworkOwner(), actor = client?.getUserId();
  useEffect(() => onMatrixUpdate(() => redraw(value => value + 1)), []);
  const choices = roleMentionChoices(client, roomId);
  if (!choices.length) return null;
  return <><DropdownMenuSeparator/><DropdownMenuLabel>Mention a server role</DropdownMenuLabel>{choices.map(choice => <DropdownMenuItem
    key={choice.serverId + '/' + choice.roleId} disabled={disabled}
    aria-label={'Mention role ' + choice.name + ' (' + choice.roleId + ') in ' + choice.serverName}
    onSelect={() => {
      if (disabled || client !== getMatrixClient() || owner !== accountArtworkOwner() || client?.getUserId() !== actor) return;
      const fresh = roleMentionChoices(client, roomId).find(role => role.serverId === choice.serverId && role.roleId === choice.roleId);
      if (fresh) onSelect(roleMentionToken(fresh));
    }}><span>{choice.name}<small className='block text-xs opacity-70'>{choice.serverName} · {choice.roleId}</small></span></DropdownMenuItem>)}</>;
}
