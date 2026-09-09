import { isValidElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
export type ContextAction = { label: string; run: () => unknown; danger?: boolean; separator?: boolean; visible?: boolean };
export function ActionMenu({ children, actions }: { children: ReactNode; actions: ContextAction[] }) {
  const items = actions.filter(a => a.visible !== false);
  if (!items.length || !isValidElement(children)) return children;
  return <ContextMenu><ContextMenuTrigger asChild>{children}</ContextMenuTrigger><ContextMenuContent className="tavern-context-menu">{items.map((a, i) => <span key={a.label}>{a.separator && i > 0 && <ContextMenuSeparator/>}<ContextMenuItem variant={a.danger ? 'destructive' : 'default'} onSelect={() => { try { Promise.resolve(a.run()).catch(e => toast.error(e.message || 'Action failed. Please try again.')); } catch (e: any) { toast.error(e.message); } }}>{a.label}</ContextMenuItem></span>)}</ContextMenuContent></ContextMenu>;
}
export async function copyText(value: string, message = 'Copied') { await navigator.clipboard.writeText(value); toast.success(message); }
