import { requestApi } from './api';

export type HierarchyRoom = { roomId: string; status: 'available' | 'unavailable'; reason?: string; name?: string | null;
  kind?: 'server' | 'conversation'; roomVersion?: string; creators?: string[]; creatorAuthority?: string;
  createdAt?: number | null; joinedMembers?: number; encryption?: string | null; joinRule?: string | null;
  archived?: boolean | null; replacementRoomId?: string | null };
export type HierarchyLink = { direction: 'parent' | 'child'; roomId: string; canonical: boolean;
  status: 'confirmed' | 'unconfirmed' | 'malformed' | 'unavailable' | 'cycle'; reason?: string; room?: HierarchyRoom };
export type HierarchyPage = { room: HierarchyRoom; links: HierarchyLink[]; revision: string | null;
  nextOffset: number | null; omittedLinks: number; truncated: boolean; checkedAt: number };
export const HIERARCHY_DEPTH = 8, HIERARCHY_NODES = 100;
const invalid = () => { throw new Error('The homeserver hierarchy response could not be read. Reload this node.'); };
function room(value: any, expected: string): value is HierarchyRoom {
  if (!value || value.roomId !== expected || !['available', 'unavailable'].includes(value.status)) return false;
  if (value.status === 'unavailable') return typeof value.reason === 'string';
  return ['server', 'conversation'].includes(value.kind) && typeof value.roomVersion === 'string' &&
    Array.isArray(value.creators) && value.creators.length > 0 && value.creators.length <= 21 && value.creators.every((id: unknown) => typeof id === 'string') &&
    Number.isSafeInteger(value.joinedMembers) && value.joinedMembers >= 0 &&
    (value.createdAt === null || Number.isSafeInteger(value.createdAt) && value.createdAt > 0) &&
    (value.name === null || typeof value.name === 'string') && (value.encryption === null || typeof value.encryption === 'string') &&
    (value.joinRule === null || typeof value.joinRule === 'string') && (value.archived === null || typeof value.archived === 'boolean') &&
    (value.replacementRoomId === null || typeof value.replacementRoomId === 'string') && ['inherent', 'power-level based'].includes(value.creatorAuthority);
}
export async function fetchHierarchy(roomId: string, offset = 0, revision?: string): Promise<HierarchyPage> {
  const data = await requestApi('/admin/rooms/' + encodeURIComponent(roomId) + '/hierarchy?from=' + offset + (revision ? '&revision=' + revision : ''));
  if (!room(data?.room, roomId) || !Array.isArray(data.links) || data.links.length > 20 ||
      (data.revision !== null && !/^[a-f0-9]{64}$/.test(data.revision)) ||
      (data.nextOffset !== null && (!Number.isSafeInteger(data.nextOffset) || data.nextOffset !== offset + 20 || data.nextOffset >= 200)) ||
      !Number.isSafeInteger(data.omittedLinks) || data.omittedLinks < 0 || typeof data.truncated !== 'boolean' || !Number.isSafeInteger(data.checkedAt)) return invalid();
  for (const link of data.links) {
    if (!link || !['parent', 'child'].includes(link.direction) || typeof link.roomId !== 'string' || typeof link.canonical !== 'boolean' ||
      !['confirmed', 'unconfirmed', 'malformed', 'unavailable', 'cycle'].includes(link.status) ||
      (link.status === 'confirmed' ? !room(link.room, link.roomId) || link.room.status !== 'available' : typeof link.reason !== 'string')) return invalid();
  }
  if (data.room.status === 'available' && !data.revision || data.room.status === 'unavailable' && (data.links.length || data.nextOffset !== null)) return invalid();
  return data;
}
