import { cloneElement, isValidElement, useEffect, useState, type ReactNode } from 'react';
import { Building2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { onMatrixUpdate } from '@/lib/matrix';
import { serverNavigationOwner } from '@/lib/server-navigation';
import { ActionMenu, type ContextAction } from './action-menu';
import { ServerNavigation, type ServerNavigationReadState } from './server-navigation';
import './mobile-server-navigation.css';
type Server = { id: string; name: string };
export function MobileServerNavigation({ servers, active, onSelectServer, serverActions, readState }: { readState?: ServerNavigationReadState; servers: Server[]; active: string; onSelectServer: (id: string) => void; serverActions?: (server: Server) => ContextAction[] }) {
  const [scope, setScope] = useState<ReturnType<typeof serverNavigationOwner> | null>(null);
  useEffect(() => onMatrixUpdate(() => setScope(previous => previous && !previous.current() ? null : previous)), []);
  const select = (id: string) => { if (!scope?.current()) return; setScope(null); onSelectServer(id); };
  function renderServer(server: Server, button: ReactNode, organization: ContextAction[]) {
    const row = isValidElement<{ className?: string; children?: ReactNode }>(button) ? cloneElement(button, { className: (button.props.className || '') + ' mobile-server-row' },
      <><span className='mobile-server-row-icon'>{button.props.children}</span><span className='mobile-server-row-name'>{server.name}</span></>) : button;
    const management = (serverActions?.(server) || []).map(action => ({ ...action, run: () => { if (!scope?.current()) return; setScope(null); return action.run(); } }));
    return <ActionMenu actions={[...management, ...organization]}>{row}</ActionMenu>;
  }
  return <><button type='button' className='mobile-server-navigation-trigger secondary-button' aria-label='Servers and folders' aria-haspopup='dialog' onClick={() => { const next = serverNavigationOwner(); if (next.current()) setScope(next); }}><Building2 size={18} aria-hidden='true'/><span>Servers and folders</span></button>
    <Dialog open={!!scope?.current()} onOpenChange={open => { if (!open) setScope(null); }}><DialogContent className='tavern-dialog mobile-server-navigation-dialog'><DialogHeader><DialogTitle>Servers and folders</DialogTitle><DialogDescription>Choose a server. Use the Move buttons to organize your servers without dragging.</DialogDescription></DialogHeader>
      <button type='button' className='secondary-button mobile-all-conversations' aria-current={active === 'all' ? 'page' : undefined} onClick={() => select('all')}>All channels</button>
      <button type='button' className='secondary-button mobile-all-conversations' aria-current={active === 'dms' ? 'page' : undefined} onClick={() => select('dms')}>Direct messages</button>
      {scope?.current() && <ServerNavigation readState={readState} servers={servers} active={active} onSelectServer={select} renderServer={renderServer}/>}
      {!servers.length && <p>You have not joined a server yet. Choose Direct messages to open your private conversations.</p>}
    </DialogContent></Dialog></>;
}
