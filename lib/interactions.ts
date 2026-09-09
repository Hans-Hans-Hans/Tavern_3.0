import type { MatrixClient } from 'matrix-js-sdk';
import { accountArtworkOwner, isManagedAccount } from './api';
import { setUserBlocked } from './social';
import { getMatrixClient, mutateMatrixAccountData } from './matrix';
import { navigationAccountKey, navigationLists, noteNavigationUnreadChange } from './read-state';
import { readRolePolicy, effectiveRolePermissions, rolesEvent, type RolePermission } from './roles';
function roleAllows(roomId:string,userId:string,permission:RolePermission){
  const c=getMatrixClient(),room=c?.getRoom(roomId);if(!room||!c)return false;
  const parents=room.isSpaceRoom()?[roomId]:room.currentState.getStateEvents('m.space.parent').filter(e=>e.getContent().canonical&&e.getContent().via?.length).map(e=>e.getStateKey()!).filter(id=>c.getRoom(id)?.currentState.getStateEvents('m.space.child',roomId)?.getContent().via?.length);
  return parents.every(id=>{const event=c.getRoom(id)?.currentState.getStateEvents(rolesEvent,'');if(!event)return true;const policy=readRolePolicy(id);return !!policy&&effectiveRolePermissions(policy,userId,roomId).has(permission);});
}
export function messagePermissions(roomId: string, sender: string) {
  const c = getMatrixClient(), r = c?.getRoom(roomId), me = c?.getUserId();
  const joined = !!r && !!me && r.getMyMembership() === 'join';
  const send=joined&&roleAllows(roomId,me,'send_messages')&&r.currentState.maySendEvent(r.hasEncryptionStateEvent()?'m.room.encrypted':'m.room.message',me);
  return { edit: send && sender === me, delete: joined && (sender === me || (roleAllows(roomId,me,'manage_messages')&&r.currentState.hasSufficientPowerLevelFor('redact', r.getMember(me)?.powerLevel || 0))), pin: joined && roleAllows(roomId,me,'pin_messages')&&r.currentState.maySendStateEvent('m.room.pinned_events', me), react: joined && roleAllows(roomId,me,'add_reactions')&&r.currentState.maySendEvent('m.reaction', me), send };
}
export function canInviteToRoom(roomId:string){const c=getMatrixClient(),r=c?.getRoom(roomId),me=c?.getUserId();return !!(c&&r&&me&&r.getMyMembership()==='join'&&r.canInvite(me)&&roleAllows(roomId,me,'invite'));}
const navKey = navigationAccountKey;
export function navigationPreferences(c: MatrixClient | null = getMatrixClient()): { favorites: string[]; unread: string[] } {
  return navigationLists(c?.getAccountData(navKey as any)?.getContent());
}
let queue: Promise<unknown> = Promise.resolve();
export function setNavigationFlag(roomId: string, key: 'favorites' | 'unread', enabled: boolean) {
  const c = getMatrixClient(); if (!c) throw new Error('Sign in first.');
  const actor = c.getUserId(), generation = accountArtworkOwner();
  const current = () => { if (getMatrixClient() !== c || c.getUserId() !== actor || accountArtworkOwner() !== generation) throw new Error('Your account changed. Retry this action from your current account.'); };
  if (key === 'unread') noteNavigationUnreadChange(c, roomId);
  return mutateMatrixAccountData(c, navKey, old => { const prefs = navigationLists(old); prefs[key] = enabled ? [...new Set([...prefs[key], roomId])].slice(0, 1000) : prefs[key].filter(id => id !== roomId); return { ...(old && typeof old === 'object' && !Array.isArray(old) ? old : {}), ...prefs }; }, current);
}
export async function blockUser(userId: string, blocked: boolean) {
  if(isManagedAccount())return setUserBlocked(userId,blocked);
  const c = getMatrixClient(); if (!c || c.getUserId() === userId) throw new Error('Choose another user.');
  const task = queue.catch(() => {}).then(async () => { const ids = c.getIgnoredUsers(); await c.setIgnoredUsers(blocked ? [...new Set([...ids, userId])] : ids.filter(id => id !== userId)); }); queue = task; return task;
}
export function isUserBlocked(userId: string) { return getMatrixClient()?.getIgnoredUsers().includes(userId) || false; }
