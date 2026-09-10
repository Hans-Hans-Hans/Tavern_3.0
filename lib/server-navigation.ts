import { getMatrixClient } from './matrix';
import { accountArtworkOwner } from './api';
export type ServerFolder = { id: string; name: string; color: string; serverIds: string[] };
export type ServerNavigationState = { version: 1; folders: ServerFolder[]; order: string[]; collapsed: string[] };
export const serverNavigationNamespace = 'io.tavern.server_folders';
export function normalizeServerNavigation(value: unknown): ServerNavigationState { const p = (value && typeof value === 'object' ? value : {}) as any, ids = new Set<string>(), servers = new Set<string>(), folders: ServerFolder[] = []; for (const raw of Array.isArray(p.folders) ? p.folders.slice(0, 32) : []) { if (!raw || typeof raw.id !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(raw.id) || ids.has(raw.id) || typeof raw.name !== 'string' || !raw.name.trim()) continue; ids.add(raw.id); const serverIds: string[] = []; for (const id of Array.isArray(raw.serverIds) ? raw.serverIds.slice(0, 1000) : []) { if (typeof id !== 'string' || !id.startsWith('!') || id.length > 255 || servers.has(id)) continue; servers.add(id); serverIds.push(id); } folders.push({ id: raw.id, name: raw.name.trim().slice(0, 60), color: /^#[a-f\d]{6}$/i.test(raw.color) ? raw.color : '', serverIds }); } return { version: 1, folders, order: [...new Set<string>((Array.isArray(p.order) ? p.order : []).filter((id: unknown) => typeof id === 'string' && id.startsWith('!') && id.length <= 255))].slice(0, 1000), collapsed: [...new Set<string>((Array.isArray(p.collapsed) ? p.collapsed : []).filter((id: unknown) => typeof id === 'string' && ids.has(id)))] }; }
export function serverFolderId(state: ServerNavigationState, id: string) { return state.folders.find(folder => folder.serverIds.includes(id))?.id || ''; }
export function orderedServerIds(state: ServerNavigationState, known: readonly string[]) { return [...new Set([...state.order, ...known, ...state.folders.flatMap(folder => folder.serverIds)])]; }
export function moveServerToFolder(state: ServerNavigationState, serverId: string, folderId: string) { if (folderId && !state.folders.some(f => f.id === folderId)) throw new Error('That folder no longer exists.'); return { ...state, folders: state.folders.map(folder => ({ ...folder, serverIds: [...folder.serverIds.filter(id => id !== serverId), ...(folder.id === folderId ? [serverId] : [])] })) }; }
export function positionServer(state: ServerNavigationState, serverId: string, folderId: string, beforeId: string, known: readonly string[]) {
  if (beforeId === serverId) return state;
  const order = orderedServerIds(state, known).filter(id => id !== serverId);
  if (beforeId && (!order.includes(beforeId) || serverFolderId(state, beforeId) !== folderId)) throw new Error('The destination changed. Choose a position again.');
  const next = moveServerToFolder(state, serverId, folderId);
  const peers = order.filter(id => serverFolderId(next, id) === folderId);
  const at = beforeId ? order.indexOf(beforeId) : peers.length ? order.indexOf(peers[peers.length - 1]) + 1 : order.length;
  order.splice(at, 0, serverId); return { ...next, order };
}
export function moveServerRelative(state: ServerNavigationState, id: string, target: string, side: 'before' | 'after', known: readonly string[]) {
  if (id === target) return state;
  const folder = serverFolderId(state, target), peers = orderedServerIds(state, known).filter(value => value !== id && serverFolderId(state, value) === folder);
  const index = peers.indexOf(target); if (index < 0) throw new Error('That server is no longer available.');
  return positionServer(state, id, folder, side === 'before' ? target : peers[index + 1] || '', known);
}
export function positionFolder(state: ServerNavigationState, id: string, beforeId: string) {
  if (id === beforeId) return state;
  const folder = state.folders.find(item => item.id === id), rest = state.folders.filter(item => item.id !== id);
  if (!folder || beforeId && !rest.some(item => item.id === beforeId)) throw new Error('That folder no longer exists.');
  rest.splice(beforeId ? rest.findIndex(item => item.id === beforeId) : rest.length, 0, folder); return { ...state, folders: rest };
}
/** Merge only the editor's changes; unrelated remote folder edits survive. */
export function saveServerFolder(state: ServerNavigationState, draft: ServerFolder, original: ServerFolder | null) {
  if (!draft.name.trim()) throw new Error('Enter a folder name.');
  const current = state.folders.find(folder => folder.id === draft.id);
  if (original && !current) throw new Error('This folder was removed on another device. Reopen the editor.');
  if (!original && (current || state.folders.length >= 32)) throw new Error('This folder cannot be created. Refresh your folders.');
  const added = draft.serverIds.filter(id => !original?.serverIds.includes(id)), removed = new Set(original?.serverIds.filter(id => !draft.serverIds.includes(id)) || []);
  const folder = { ...(current || draft), name: !original || draft.name !== original.name ? draft.name : current!.name, color: !original || draft.color !== original.color ? draft.color : current!.color,
    serverIds: [...new Set([...(current?.serverIds || []).filter(id => !removed.has(id)), ...added])] };
  return { ...state, folders: current ? state.folders.map(item => item.id === draft.id ? folder : { ...item, serverIds: item.serverIds.filter(id => !added.includes(id)) }) : [...state.folders.map(item => ({ ...item, serverIds: item.serverIds.filter(id => !added.includes(id)) })), folder] };
}
export function serverNavigationOwner() {
  const client = getMatrixClient(), user = client?.getUserId(), device = client?.getDeviceId(), base = client?.getHomeserverUrl(), account = accountArtworkOwner();
  const current = () => !!client && getMatrixClient() === client && client.getUserId() === user && client.getDeviceId() === device && client.getHomeserverUrl() === base && accountArtworkOwner() === account;
  return { client, current, check: () => { if (!current()) throw new Error('Your account changed. Reopen server organization.'); } };
}
type Mutation = (old: ServerNavigationState) => ServerNavigationState;
type Pending = { mutate: Mutation };
type Session = { owner: ReturnType<typeof serverNavigationOwner>; confirmed: ServerNavigationState; view: ServerNavigationState; cache: string; pending: Pending[]; queue: Promise<unknown> };
let session: Session | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const cached = () => normalizeServerNavigation(getMatrixClient()?.getAccountData(serverNavigationNamespace as any)?.getContent());
function projection(s: Session) { let next = s.confirmed; for (const pending of s.pending) { try { next = normalizeServerNavigation(pending.mutate(next)); } catch { /* A now-invalid pending intent will reject when its turn is persisted. */ } } s.view = next; }
function currentSession() {
  if (!session || !session.owner.current()) { const initial = cached(); session = { owner: serverNavigationOwner(), confirmed: initial, view: initial, cache: JSON.stringify(initial), pending: [], queue: Promise.resolve() }; }
  return session;
}
export function readServerNavigation() { return currentSession().view; }
export function refreshServerNavigation() {
  const s = currentSession(), incoming = cached(), key = JSON.stringify(incoming);
  if (key !== s.cache) { s.cache = key; s.confirmed = incoming; projection(s); }
  notify();
}
export function subscribeServerNavigation(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Each local intent merges against a fresh native document. Native account data
 * has no CAS: cross-device concurrent PUTs are last-write-wins. Never replay an
 * ambiguous write; subsequent sync/fresh reads restore the authoritative view. */
export function updateServerNavigation(mutate: Mutation) {
  const s = currentSession(); s.owner.check(); const pending = { mutate }; s.pending.push(pending); projection(s); notify();
  const path = '/user/' + encodeURIComponent(s.owner.client!.getUserId()!) + '/account_data/' + serverNavigationNamespace;
  const nativeRead = async () => {
    s.owner.check(); let value: any;
    try { value = await s.owner.client!.http.authedRequest('GET' as any, path, undefined, undefined, { localTimeoutMs: 15000 }); }
    catch (error) { s.owner.check(); if ((error as any)?.errcode !== 'M_NOT_FOUND') throw error; value = {}; }
    s.owner.check();
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== undefined && value.version !== 1) throw new Error('These saved folders use an unsupported format. They have been left unchanged.');
    return value;
  };
  const task = s.queue.catch(() => {}).then(async () => {
    const raw = await nativeRead(); s.confirmed = normalizeServerNavigation(raw); projection(s); notify();
    const next = normalizeServerNavigation(mutate(s.confirmed)); s.owner.check();
    await s.owner.client!.http.authedRequest('PUT' as any, path, undefined, { ...raw, ...next }, { localTimeoutMs: 15000 }); s.owner.check();
    const actual = normalizeServerNavigation(await nativeRead()); s.confirmed = actual;
    if (JSON.stringify(actual) !== JSON.stringify(next)) throw new Error('Another device changed your organization. The latest saved order is shown.');
    return actual;
  }).finally(() => { s.pending = s.pending.filter(item => item !== pending); if (s.owner.current()) { projection(s); notify(); } });
  s.queue = task; return task;
}
