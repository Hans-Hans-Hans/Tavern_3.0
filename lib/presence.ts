import type { MatrixClient, SetPresence } from 'matrix-js-sdk';
import { getMatrixClient } from './matrix';
export type PresenceMode = 'online' | 'away' | 'dnd' | 'invisible';
export const presenceLabels: Record<PresenceMode, string> = { online: 'Online', away: 'Away', dnd: 'Do not disturb', invisible: 'Invisible' };
export const presenceAccountKey = 'io.tavern.presence';
export function readPresenceMode(c: MatrixClient | null = getMatrixClient()): PresenceMode { const value = c?.getAccountData(presenceAccountKey as any)?.getContent().mode; return value === 'away' || value === 'dnd' || value === 'invisible' ? value : 'online'; }
export function presenceProtocolValue(mode: PresenceMode): 'online' | 'unavailable' | 'offline' { return mode === 'away' ? 'unavailable' : mode === 'invisible' ? 'offline' : 'online'; }
export async function applyPresenceMode(c: MatrixClient) { const mode = readPresenceMode(c), presence = presenceProtocolValue(mode); await c.setSyncPresence(presence as SetPresence); await c.setPresence({ presence, status_msg: mode === 'dnd' ? 'Do not disturb' : '' }); }
export async function setPresenceMode(mode: PresenceMode) { const c = getMatrixClient(); if (!c) throw new Error('Sign in to set your presence.'); if (!(mode in presenceLabels)) throw new Error('Choose a valid presence.'); const presence = presenceProtocolValue(mode); await c.setPresence({ presence, status_msg: mode === 'dnd' ? 'Do not disturb' : '' }); await c.setSyncPresence(presence as SetPresence); await c.setAccountData(presenceAccountKey as any, { mode } as any); }
