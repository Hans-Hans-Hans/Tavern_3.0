import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServerEmojiManager } from '../../../app/server-emoji';
import { Toaster } from 'sonner';
import '../../../app/globals.css';
import '../../../app/product.css';

export function mountFixture() {
  const f: any = { listeners: new Set(), allowed: true, joined: true, writes: [], uploads: 0,
    emoji: [{ name: 'cheers', uri: 'mxc://local/cheers', creator: '@owner:local', aliases: ['celebrate'] }],
    reject: false, delayUpload: false, releaseUpload: null,
  };
  const room = { isSpaceRoom: () => true, getMyMembership: () => f.joined ? 'join' : 'leave', currentState: {
    maySendStateEvent: () => f.allowed, getStateEvents: () => ({ getContent: () => ({ emoji: f.emoji }) }),
  } };
  f.notify = () => f.listeners.forEach((listener: () => void) => listener());
  f.image = ({ name, size }: { name: string; size: number }) => <img src='/test-emoji-image' alt={name} width={size} height={size} />;
  f.client = { getUserId: () => '@owner:local', getDeviceId: () => 'D1', getHomeserverUrl: () => 'https://local', getRoom: () => room,
    getStateEvent: async () => ({ emoji: f.emoji }),
    uploadContent: async () => { f.uploads++; if (f.delayUpload) await new Promise(resolve => { f.releaseUpload = resolve; }); return { content_uri: 'mxc://local/upload' }; },
    sendStateEvent: async (_room: string, _type: string, content: any) => {
      if (f.reject) throw new Error('Server rejected this change. Try again.');
      f.emoji = content.emoji; f.writes.push(content); f.notify();
    },
  };
  (window as any).emojiManagerFixture = f;
  const root = createRoot(document.getElementById('root')!);
  f.unmount = () => root.unmount();
  root.render(<main style={{ maxWidth: 760, padding: 12, margin: 'auto' }}><ServerEmojiManager serverId='!server:local' /><Toaster /></main>);
}
