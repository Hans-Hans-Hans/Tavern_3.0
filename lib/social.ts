import { getMatrixClient } from './matrix';
import { requestApi } from './api';
export type ContactRequest = { id: string; sender: string; target: string; status: 'pending' | 'accepted'; created: number; updated: number };
export type SocialState = { requests: ContactRequest[]; blocked: string[]; privacy: 'everyone' | 'shared_server' | 'nobody'; hasMore: boolean };
export async function socialApi(path = '', method = 'GET', body?: object): Promise<SocialState> { return requestApi('/social' + path, body, method); }
export function contactPeer(request: ContactRequest, me: string) { return request.sender === me ? request.target : request.sender; }
export function observeContacts(onChanged: () => void) { const events = new EventSource('/api/social/events'); events.onmessage = () => onChanged(); return () => events.close(); }
export function blockedUsers() { return getMatrixClient()?.getIgnoredUsers() || []; }
export async function setUserBlocked(userId: string, blocked: boolean) { return socialApi('/blocks/' + encodeURIComponent(userId), blocked ? 'PUT' : 'DELETE'); }
export async function sendContactRequest(userId: string) { return socialApi('/requests', 'POST', { target: userId }); }
