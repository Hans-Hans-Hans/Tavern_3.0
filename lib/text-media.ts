import { useEffect, useState } from 'react';
import { getMatrixClient, onMatrixUpdate } from './matrix';
export type TextMediaPreferences = { enterToSend: boolean; inlineImages: boolean };
const eventType = 'io.tavern.text_media';
export function normalizeTextMedia(value: any): TextMediaPreferences { return { enterToSend: value?.enterToSend !== false, inlineImages: value?.inlineImages !== false }; }
export function readTextMedia() { return normalizeTextMedia(getMatrixClient()?.getAccountData(eventType as any)?.getContent()); }
export function shouldSendOnKey(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean }, enterToSend: boolean) { return event.key === 'Enter' && !event.isComposing && !event.shiftKey && (enterToSend || event.ctrlKey || event.metaKey); }
export function useTextMedia() { const [value, setValue] = useState(readTextMedia); useEffect(() => onMatrixUpdate(() => setValue(readTextMedia())), []); return value; }
let queue: Promise<unknown> = Promise.resolve();
export function saveTextMedia(change: Partial<TextMediaPreferences>) {
  const client = getMatrixClient(); if (!client) return Promise.reject(new Error('Sign in before changing message preferences.'));
  const next = queue.catch(() => {}).then(async () => { if (client !== getMatrixClient()) throw new Error('Your account changed. Reopen settings.'); const value = normalizeTextMedia({ ...readTextMedia(), ...change }); await client.setAccountData(eventType as any, value as any); return value; }); queue = next; return next;
}
