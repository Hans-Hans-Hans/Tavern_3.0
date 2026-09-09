import { getMatrixClient } from './matrix';
import { accountArtworkOwner, requestApi } from './api';
export type ContactRequest = { id: string; sender: string; target: string; status: 'pending' | 'accepted'; created: number; updated: number };
export type SocialState = { requests: ContactRequest[]; blocked: string[]; privacy: 'everyone' | 'shared_server' | 'nobody'; hasMore: boolean };
export async function socialApi(path = '', method = 'GET', body?: object): Promise<SocialState> {
  const owner = getMatrixClient(), actor = owner?.getUserId(), generation = accountArtworkOwner();
  const current = () => { if (getMatrixClient() !== owner || owner?.getUserId() !== actor || accountArtworkOwner() !== generation) throw new Error('Your account changed. Reopen Contacts before continuing.'); };
  try { const value = await requestApi<SocialState>('/social' + path, body, method); current(); return value; }
  catch (error) { current(); throw error; }
}
export function contactPeer(request: ContactRequest, me: string) { return request.sender === me ? request.target : request.sender; }
let contactStream: { events: EventSource; owner: ReturnType<typeof getMatrixClient>; actor: string | null; generation: object } | null = null;
const contactObservers = new Set<{ owner: ReturnType<typeof getMatrixClient>; actor: string | null; generation: object; changed: () => void }>();
export function observeContacts(onChanged: () => void) {
  const owner = getMatrixClient(); if (!owner) return () => {};
  const actor = owner.getUserId(), generation = accountArtworkOwner(), observer = { owner, actor, generation, changed: onChanged }; contactObservers.add(observer);
  if (contactStream?.owner !== owner || contactStream?.actor !== actor || contactStream?.generation !== generation) {
    contactStream?.events.close();
    for (const listener of contactObservers) if (listener.owner !== owner || listener.actor !== actor || listener.generation !== generation) contactObservers.delete(listener);
    const events = new EventSource('/api/social/events'); contactStream = { events, owner, actor, generation };
    events.onmessage = () => {
      if (contactStream?.events !== events) return;
      if (getMatrixClient() !== owner || owner.getUserId() !== actor || accountArtworkOwner() !== generation) { events.close(); contactStream = null; return; }
      for (const listener of contactObservers) if (listener.owner === owner && listener.actor === actor && listener.generation === generation) listener.changed();
    };
  }
  return () => {
    contactObservers.delete(observer);
    if (contactStream?.owner === owner && contactStream.actor === actor && contactStream.generation === generation && ![...contactObservers].some(listener => listener.owner === owner && listener.actor === actor && listener.generation === generation)) { contactStream.events.close(); contactStream = null; }
  };
}
export function blockedUsers() { return getMatrixClient()?.getIgnoredUsers() || []; }
export async function setUserBlocked(userId: string, blocked: boolean) { return socialApi('/blocks/' + encodeURIComponent(userId), blocked ? 'PUT' : 'DELETE'); }
export async function sendContactRequest(userId: string) { return socialApi('/requests', 'POST', { target: userId }); }
