import { Bell, Building2, MessageCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { ProfileMenu } from './profile-menu';

export function MobileNavigation({ name, avatar, direct, notifications, onServers, onMessages, onNotifications, onProfile, onSettings, onPrivacy, onAbout, admin }: {
  name: string; avatar: ReactNode; direct: boolean; notifications: boolean;
  onServers: () => void; onMessages: () => void; onNotifications: () => void; onProfile: () => void; onSettings: () => void;
  onPrivacy: () => void; onAbout: () => void; admin?: boolean;
}) {
  return <nav className="mobile-navigation" aria-label="Mobile navigation">
    <ProfileMenu name={name} admin={admin} onProfile={onProfile} onSettings={onSettings} onPrivacy={onPrivacy} onAbout={onAbout}><button className="mobile-profile" aria-label="Your profile">{avatar}<span><strong>{name}</strong><small>Account</small></span></button></ProfileMenu>
    <button className="mobile-nav-action" aria-label="Browse servers" aria-current={!direct && !notifications ? 'page' : undefined} onClick={onServers}><Building2 size={21}/><span>Servers</span></button>
    <button className="mobile-nav-action" aria-label="Browse direct messages" aria-current={direct && !notifications ? 'page' : undefined} onClick={onMessages}><MessageCircle size={21}/><span>Messages</span></button>
    <button className="mobile-nav-action" aria-label="Your mentions" aria-current={notifications ? 'page' : undefined} onClick={onNotifications}><Bell size={21}/><span>Mentions</span></button>
  </nav>;
}
