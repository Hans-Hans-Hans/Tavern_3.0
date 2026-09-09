import type { MatrixClient } from 'matrix-js-sdk';
import { getMatrixClient } from './matrix';
const namespace = 'io.tavern.thread_preferences';
export type ThreadNotificationMode = 'inherit' | 'all' | 'mentions' | 'nothing';
type Preferences = Record<string, { roomId: string; mode: ThreadNotificationMode }>;
export function normalizeThreadPreferences(value: any): Preferences { return Object.fromEntries(Object.entries(value?.threads || {}).slice(0, 1000).filter(([id, entry]: [string, any]) => id.startsWith('$') && id.length <= 1024 && typeof entry?.roomId === 'string' && entry.roomId.startsWith('!') && ['all', 'mentions', 'nothing'].includes(entry.mode)).map(([id, entry]: [string, any]) => [id, { roomId: entry.roomId, mode: entry.mode }])); }
export function readThreadNotification(roomId: string, rootId: string, client: MatrixClient | null = getMatrixClient()): ThreadNotificationMode { const value = normalizeThreadPreferences(client?.getAccountData(namespace as any)?.getContent())[rootId]; return value?.roomId === roomId ? value.mode : 'inherit'; }
let queue: Promise<unknown> = Promise.resolve();
export function saveThreadNotification(roomId: string, rootId: string, mode: ThreadNotificationMode) {
  const client = getMatrixClient(); if (!client) throw new Error('Sign in first.');
  const task = queue.catch(() => {}).then(async () => { const previous = normalizeThreadPreferences(await client.getAccountDataFromServer(namespace as any)); if (mode === 'inherit') delete previous[rootId]; else { if (!previous[rootId] && Object.keys(previous).length >= 1000) throw new Error('Your thread preferences are full. Reset an older thread to inherit first.'); previous[rootId] = { roomId, mode }; } await client.setAccountData(namespace as any, { version: 1, threads: previous } as any); }); queue = task; return task;
}
