import { Bell, Building2, MessageCircle, Settings } from 'lucide-react';
import type { ReactNode } from 'react';

export function MobileNavigation({ name, avatar, direct, notifications, onServers, onMessages, onNotifications, onProfile, onSettings }: {
  name: string; avatar: ReactNode; direct: boolean; notifications: boolean;
  onServers: () => void; onMessages: () => void; onNotifications: () => void; onProfile: () => void; onSettings: () => void;
}) {
  return <nav className="mobile-navigation" aria-label="Mobile navigation">
    <button className="mobile-profile" aria-label="Your profile" onClick={onProfile}>{avatar}<span><strong>{name}</strong><small>You</small></span></button>
    <button className="mobile-nav-action" aria-label="Browse servers" aria-current={!direct && !notifications ? 'page' : undefined} onClick={onServers}><Building2 size={21}/><span>Servers</span></button>
    <button className="mobile-nav-action" aria-label="Browse direct messages" aria-current={direct && !notifications ? 'page' : undefined} onClick={onMessages}><MessageCircle size={21}/><span>Messages</span></button>
    <button className="mobile-nav-action" aria-label="Your mentions" aria-current={notifications ? 'page' : undefined} onClick={onNotifications}><Bell size={21}/><span>Mentions</span></button>
    <button className="mobile-nav-action mobile-settings" aria-label="User settings" onClick={onSettings}><Settings size={21}/><span>Settings</span></button>
  </nav>;
}
