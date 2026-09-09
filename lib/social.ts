import { getMatrixClient } from './matrix';
import { requestApi } from './api';
export type ContactRequest = { id: string; sender: string; target: string; status: 'pending' | 'accepted'; created: number; updated: number };
export type SocialState = { requests: ContactRequest[]; blocked: string[]; privacy: 'everyone' | 'shared_server' | 'nobody'; hasMore: boolean };
export async function socialApi(path = '', method = 'GET', body?: object): Promise<SocialState> { return requestApi('/social' + path, body, method); }
export function contactPeer(request: ContactRequest, me: string) { return request.sender === me ? request.target : request.sender; }
let contactStream: { events: EventSource; owner: ReturnType<typeof getMatrixClient> } | null = null;
const contactObservers = new Set<{ owner: ReturnType<typeof getMatrixClient>; changed: () => void }>();
export function observeContacts(onChanged: () => void) {
  const owner = getMatrixClient(); if (!owner) return () => {};
  const observer = { owner, changed: onChanged }; contactObservers.add(observer);
  if (contactStream?.owner !== owner) {
    contactStream?.events.close();
    for (const listener of contactObservers) if (listener.owner !== owner) contactObservers.delete(listener);
    const events = new EventSource('/api/social/events'); contactStream = { events, owner };
    events.onmessage = () => {
      if (contactStream?.events !== events) return;
      if (getMatrixClient() !== owner) { events.close(); contactStream = null; return; }
      for (const listener of contactObservers) if (listener.owner === owner) listener.changed();
    };
  }
  return () => {
    contactObservers.delete(observer);
    if (contactStream?.owner === owner && ![...contactObservers].some(listener => listener.owner === owner)) { contactStream.events.close(); contactStream = null; }
  };
}
export function blockedUsers() { return getMatrixClient()?.getIgnoredUsers() || []; }
export async function setUserBlocked(userId: string, blocked: boolean) { return socialApi('/blocks/' + encodeURIComponent(userId), blocked ? 'PUT' : 'DELETE'); }
export async function sendContactRequest(userId: string) { return socialApi('/requests', 'POST', { target: userId }); }
