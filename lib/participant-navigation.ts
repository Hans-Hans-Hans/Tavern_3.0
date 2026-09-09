import { getMatrixClient } from './matrix';
export type ParticipantNavigation = { action: 'profile' | 'message'; roomId: string; userId: string };
const eventName = 'tavern:participant-navigation';
export function participantNavigationAllowed(value: unknown): value is ParticipantNavigation {
  if (!value || typeof value !== 'object') return false;
  const { action, roomId, userId } = value as ParticipantNavigation;
  if (!['profile', 'message'].includes(action) || typeof roomId !== 'string' || !/^![^\s]{1,254}$/.test(roomId) || typeof userId !== 'string' || !/^@[^\s:]+:[^\s]+$/.test(userId) || userId.length > 255) return false;
  const client = getMatrixClient(), room = client?.getRoom(roomId);
  return !!(client && room?.getMyMembership() === 'join' && room.getMember(userId)?.membership === 'join' && (action === 'profile' || userId !== client.getUserId()));
}
export function navigateParticipant(action: ParticipantNavigation['action'], roomId: string, userId: string) {
  const value = { action, roomId, userId };
  if (!participantNavigationAllowed(value)) throw new Error('This participant is no longer available in a joined conversation.');
  window.dispatchEvent(new CustomEvent(eventName, { detail: value }));
}
export function onParticipantNavigation(callback: (value: ParticipantNavigation) => void) {
  const listener = (event: Event) => { const value = (event as CustomEvent).detail; if (participantNavigationAllowed(value)) callback(value); };
  window.addEventListener(eventName, listener); return () => window.removeEventListener(eventName, listener);
}
