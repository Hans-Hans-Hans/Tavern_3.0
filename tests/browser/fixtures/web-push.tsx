import React from 'react';
import { createRoot } from 'react-dom/client';
import { WebPushSettings } from '../../../app/web-push-settings';
import { startWebPushSession, stopWebPushSession, setWebPushForegroundHandler, refreshWebPushForeground } from '../../../lib/web-push';
import '../../../app/globals.css';

export async function mountFixture() {
  const w = window as any;
  w.subscriptionCalls = 0; w.permissionCalls = 0; w.nativeSubscription = null; w.sdkHandles = false;
  const key = new Uint8Array(65); key[0] = 4;
  const native = { options: { applicationServerKey: key.buffer }, toJSON: () => ({ endpoint: 'https://push.example.test/device', keys: { p256dh: 'fixture-p256dh', auth: 'fixture-auth' } }), unsubscribe: async () => { await fetch('/fixture-push-provider', { method: 'DELETE' }); w.nativeSubscription = null; return true; } };
  Object.defineProperty(PushManager.prototype, 'getSubscription', { configurable: true, value: async () => (await (await fetch('/fixture-push-provider')).json()).active ? native : null });
  Object.defineProperty(PushManager.prototype, 'subscribe', { configurable: true, value: async () => { await fetch('/fixture-push-provider', { method: 'POST' }); w.subscriptionCalls++; w.nativeSubscription = native; return native; } });
  const request = Notification.requestPermission.bind(Notification);
  Notification.requestPermission = async () => { w.permissionCalls++; return request(); };
  await navigator.serviceWorker.register('/sw.js', { scope: '/' }); await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  setWebPushForegroundHandler(() => w.sdkHandles);
  w.setSdkHandles = (value: boolean) => { w.sdkHandles = value; refreshWebPushForeground(); };
  w.startOwner = (value: string) => startWebPushSession(value); w.stopOwner = stopWebPushSession;
  startWebPushSession('fixture-A');
  createRoot(document.getElementById('root')!).render(<WebPushSettings/>);
  w.fixtureReady = true;
}
