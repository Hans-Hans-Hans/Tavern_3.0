import { ClientEvent, Direction, MatrixEventEvent, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';

export type SearchFile = { name: string; mime: string; size: number | null; kind: 'image' | 'video' | 'audio' | 'file' };
export type SearchDocument = { id: string; roomId: string; roomName: string; authorId: string; authorName: string; body: string; timestamp: number; editedAt: number; has: ('image' | 'file' | 'link')[]; mentions: string[]; mentionRoom: boolean; file?: SearchFile };
export type SearchQuery = { terms: string[]; phrases: string[]; from: string[]; rooms: string[]; before?: number; after?: number; has: string[]; mentionsMe: boolean };
type StoredDocument = { id: string; roomId: string; timestamp: number; revision: number; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer; tags: string[]; postings: [string, number, string][] };
type Keys = { encryption: CryptoKey; search: CryptoKey };
type SearchSession = { client: MatrixClient; actor: string | null; device: string | null; current: () => boolean; database: IDBDatabase; keys: Keys; stop: () => void; generation: number; queue: Promise<void>; history: Set<string>; error: string };
let active: SearchSession | null = null, generation = 0;
const encoder = new TextEncoder(), decoder = new TextDecoder();
export const searchWords = (text: string) => [...new Set(text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])].filter(word => word.length <= 80).slice(0, 1000);
const cleanMetadata = (value: unknown, maximum: number) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, maximum) : '';
/** Search metadata stays in authenticated ciphertext. It contains no media URL,
 * attachment key or thumbnail: opening a file resolves its current native event. */
export function searchFileMetadata(content: Record<string, any>): SearchFile | undefined {
  if (!['m.image', 'm.video', 'm.audio', 'm.file'].includes(content.msgtype)) return undefined;
  const mime = cleanMetadata(content.info?.mimetype, 255).toLocaleLowerCase();
  return { name: cleanMetadata(typeof content.filename === 'string' && content.filename ? content.filename : content.body, 512) || 'Attachment',
    mime: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : '',
    size: Number.isSafeInteger(content.info?.size) && content.info.size >= 0 ? content.info.size : null,
    kind: content.msgtype === 'm.image' ? 'image' : content.msgtype === 'm.video' ? 'video' : content.msgtype === 'm.audio' ? 'audio' : 'file' };
}
function searchableText(document: SearchDocument) { return document.body + (document.file ? '\n' + document.file.name + '\n' + document.file.mime + '\n' + document.file.kind : ''); }
function documentWords(document: SearchDocument) { return [...new Set([...searchWords(searchableText(document)), ...searchWords(document.file?.name.replace(/[._-]/g, ' ') || '')])].slice(0, 1100); }

export function parseSearchQuery(input: string): SearchQuery {
  if (input.length > 1000) throw new Error('Search queries can be up to 1,000 characters.');
  const result: SearchQuery = { terms: [], phrases: [], from: [], rooms: [], has: [], mentionsMe: false };
  if ((input.match(/"/g) || []).length % 2) throw new Error('Close the quotation marks around the search phrase.');
  for (const token of input.match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    const operator = token.match(/^(from|in|before|after|has|mentions):(.*)$/i);
    if (operator) {
      const name = operator[1].toLowerCase(), value = operator[2].replace(/^"|"$/g, '').trim();
      if (!value) throw new Error(`Add a value after ${name}:.`);
      if (name === 'from') result.from.push(value.toLocaleLowerCase());
      else if (name === 'in') result.rooms.push(value.toLocaleLowerCase().replace(/^#/, ''));
      else if (name === 'has') { if (!['image', 'file', 'link'].includes(value)) throw new Error('Use has:image, has:file, or has:link.'); result.has.push(value); }
      else if (name === 'mentions') { if (value !== 'me') throw new Error('Use mentions:me to search your mentions.'); result.mentionsMe = true; }
      else { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Use dates in YYYY-MM-DD format.'); result[name as 'before' | 'after'] = Date.parse(value); }
    } else {
      const phrase = token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : '';
      if (phrase) result.phrases.push(phrase.normalize('NFKC').toLocaleLowerCase());
      result.terms.push(...searchWords(phrase || token));
    }
  }
  result.terms = [...new Set(result.terms)]; if (result.terms.length > 30) throw new Error('Use up to 30 search terms.');
  if (result.before !== undefined && result.after !== undefined && result.before <= result.after) throw new Error('The before date must follow the after date.');
  return result;
}
export function matchesSearch(doc: SearchDocument, query: SearchQuery, me: string) {
  const words = new Set(documentWords(doc)), body = searchableText(doc).normalize('NFKC').toLocaleLowerCase();
  if (query.terms.some(term => !words.has(term)) || query.phrases.some(phrase => !body.includes(phrase))) return false;
  if (query.before !== undefined && doc.timestamp >= query.before || query.after !== undefined && doc.timestamp < query.after) return false;
  if (query.from.length && !query.from.some(value => [doc.authorId.toLocaleLowerCase(), doc.authorName.toLocaleLowerCase(), doc.authorId.slice(1).split(':')[0].toLocaleLowerCase()].includes(value))) return false;
  if (query.rooms.length && !query.rooms.some(value => [doc.roomId.toLocaleLowerCase(), doc.roomName.toLocaleLowerCase()].includes(value))) return false;
  return query.has.every(kind => doc.has.includes(kind as SearchDocument['has'][number])) && (!query.mentionsMe || doc.mentions.includes(me) || doc.mentionRoom);
}
export function projectSearchDocument(event: MatrixEvent, room: Room, override?: Record<string, any>): SearchDocument | null {
  if (event.status || event.isRedacted() || event.isDecryptionFailure() || event.getType() !== 'm.room.message' || !event.getId() || !event.getSender()) return null;
  const content = override || event.getContent(); if (!override && content['m.relates_to']?.rel_type === 'm.replace') return null;
  const body = typeof content.body === 'string' ? content.body.slice(0, 32000) : '', has: SearchDocument['has'] = [];
  if (['m.image', 'm.file', 'm.video', 'm.audio'].includes(content.msgtype)) has.push('file');
  if (content.msgtype === 'm.image' || String(content.info?.mimetype || '').startsWith('image/')) has.push('image');
  if (/https?:\/\/\S+/i.test(body)) has.push('link');
  const file = searchFileMetadata(content);
  return { id: event.getId()!, roomId: room.roomId, roomName: room.name, authorId: event.getSender()!, authorName: room.getMember(event.getSender()!)?.name || event.getSender()!, body, timestamp: event.getTs(), editedAt: event.replacingEventDate()?.getTime() || event.getTs(), has, mentions: Array.isArray(content['m.mentions']?.user_ids) ? content['m.mentions'].user_ids.filter((x: unknown) => typeof x === 'string').slice(0, 1000) : [], mentionRoom: content['m.mentions']?.room === true, ...(file ? { file } : {}) };
}
export async function createSearchKeys(): Promise<Keys> { return { encryption: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']), search: await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) }; }
export async function searchTag(key: CryptoKey, word: string) { return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(word)))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
export async function sealSearchDocument(document: SearchDocument, keys: Keys): Promise<StoredDocument> {
  const iv = crypto.getRandomValues(new Uint8Array(12)), ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(document.id + '\0' + document.roomId) }, keys.encryption, encoder.encode(JSON.stringify(document)));
  const tags = await Promise.all(documentWords(document).map(word => searchTag(keys.search, word)));
  return { id: document.id, roomId: document.roomId, timestamp: document.timestamp, revision: document.editedAt, iv, ciphertext, tags, postings: tags.map(tag => [tag, document.timestamp, document.id]) };
}
export async function openSearchDocument(record: StoredDocument, keys: Keys): Promise<SearchDocument> { const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(record.id + '\0' + record.roomId) }, keys.encryption, record.ciphertext); const document = JSON.parse(decoder.decode(data)); if (document.id !== record.id || document.roomId !== record.roomId) throw new Error('Search document identity mismatch.'); return document; }
function requestResult<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error('Local search storage failed.')); }); }
function transactionDone(tx: IDBTransaction) { return new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('Local search update was interrupted.')); }); }
async function openDatabase(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name, 1); request.onupgradeneeded = () => { const db = request.result; db.createObjectStore('keys'); const docs = db.createObjectStore('documents', { keyPath: 'id' }); docs.createIndex('room', 'roomId'); docs.createIndex('time', ['timestamp', 'id']); docs.createIndex('terms', 'postings', { multiEntry: true }); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Close other Tavern tabs before opening the search index.')); });
}
async function storageKeys(database: IDBDatabase) { const existing = await requestResult(database.transaction('keys').objectStore('keys').get('crypto')) as Keys | undefined; if (existing) return existing; const keys = await createSearchKeys(), tx = database.transaction('keys', 'readwrite'); tx.objectStore('keys').put(keys, 'crypto'); await transactionDone(tx); return keys; }
function sessionRequired() { if (!active) throw new Error('Local search is still opening. Try again shortly.'); return active; }
const isActive = (session: SearchSession) => active === session && session.generation === generation && session.current() && session.client.getUserId() === session.actor && session.client.getDeviceId() === session.device;
function joined(session: SearchSession, roomId: string) { return isActive(session) && session.client.getRoom(roomId)?.getMyMembership() === 'join'; }
async function removeDocument(session: SearchSession, id: string) { if (!isActive(session)) return; const tx = session.database.transaction('documents', 'readwrite'); tx.objectStore('documents').delete(id); await transactionDone(tx); }
async function storeDocument(session: SearchSession, document: SearchDocument, validate: () => void = () => {}) {
  validate(); if (!joined(session, document.roomId)) return;
  const old = await requestResult(session.database.transaction('documents').objectStore('documents').get(document.id)) as StoredDocument | undefined;
  validate(); if (!joined(session, document.roomId) || old && old.revision > document.editedAt) return;
  const record = await sealSearchDocument(document, session.keys);
  validate(); if (!joined(session, document.roomId)) return;
  const tx = session.database.transaction('documents', 'readwrite'), store = tx.objectStore('documents'), latest = store.get(document.id);
  let validationError: unknown;
  latest.onsuccess = () => {
    try {
      validate();
      if (joined(session, document.roomId) && (!latest.result || latest.result.revision <= record.revision)) store.put(record);
    } catch (error) { validationError = error; tx.abort(); }
  };
  try { await transactionDone(tx); } catch (error) { throw validationError ?? error; }
}
async function indexEvent(session: SearchSession, event: MatrixEvent, room?: Room, validate: () => void = () => {}) {
  validate();
  room ||= session.client.getRoom(event.getRoomId()) || undefined; if (!room || !joined(session, room.roomId)) return;
  const capturedRoom = room, previousValidation = validate;
  validate = () => { previousValidation(); if (!joined(session, capturedRoom.roomId) || session.client.getRoom(capturedRoom.roomId) !== capturedRoom) throw new Error('Your account or conversation changed while indexing.'); };
  validate();
  if (event.isRedaction()) { const id = event.event.redacts || event.getContent().redacts; if (typeof id === 'string') await removeDocument(session, id); return; }
  if (event.isEncrypted()) await session.client.decryptEventIfNeeded(event).catch(() => {});
  validate();
  if (event.isDecryptionFailure()) return;
  const relation = event.getContent()['m.relates_to'];
  if (relation?.rel_type === 'm.replace' && typeof relation.event_id === 'string') {
    let original = room.findEventById(relation.event_id);
    if (!original) { try {
      const raw = await session.client.fetchRoomEvent(room.roomId, relation.event_id); validate();
      if (!raw || raw.event_id !== relation.event_id || raw.room_id !== undefined && raw.room_id !== room.roomId) return;
      original = session.client.getEventMapper()({ ...raw, room_id: room.roomId }); if (original.isEncrypted()) await session.client.decryptEventIfNeeded(original);
    } catch { return; } }
    validate();
    if (original.getSender() !== event.getSender() || original.getRoomId() !== room.roomId || original.isRedacted()) return;
    const doc = projectSearchDocument(original, room, event.getContent()['m.new_content']); if (doc) { doc.editedAt = event.getTs(); await storeDocument(session, doc, validate); } return;
  }
  const doc = projectSearchDocument(event, room); if (doc) await storeDocument(session, doc, validate); else if (event.isRedacted() && event.getId()) await removeDocument(session, event.getId()!);
}
function enqueue(session: SearchSession, fn: () => Promise<void>) { session.queue = session.queue.catch(() => {}).then(async () => { if (isActive(session)) await fn(); }).catch(e => { if (isActive(session)) session.error = (e as Error).message; }); return session.queue; }
async function forgetRoom(session: SearchSession, roomId: string) { if (!isActive(session)) return; const tx = session.database.transaction('documents', 'readwrite'), index = tx.objectStore('documents').index('room'), cursor = index.openCursor(IDBKeyRange.only(roomId)); cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } }; await transactionDone(tx); }
export async function initializeSearch(client: MatrixClient, currentOwner: () => boolean = () => true) {
  if (!currentOwner()) return;
  resetSearch(); const current = generation, actor = client.getUserId(), device = client.getDeviceId(), name = 'tavern-search-v1-' + encodeURIComponent(actor || '') + '-' + encodeURIComponent(device || '');
  const database = await openDatabase(name), keys = await storageKeys(database); if (current !== generation || !currentOwner() || client.getUserId() !== actor || client.getDeviceId() !== device) { database.close(); return; }
  const session: SearchSession = { client, actor, device, current: currentOwner, database, keys, generation: current, stop: () => {}, queue: Promise.resolve(), history: new Set(), error: '' }; active = session;
  const timeline = (event: MatrixEvent, room?: Room) => { void enqueue(session, () => indexEvent(session, event, room)); };
  const decrypted = (event: MatrixEvent) => timeline(event);
  const membership = (room: Room) => { if (room.getMyMembership() !== 'join') void enqueue(session, () => forgetRoom(session, room.roomId)); };
  client.on(RoomEvent.Timeline, timeline); client.on(MatrixEventEvent.Decrypted, decrypted); client.on(RoomEvent.Redaction, timeline); client.on(RoomEvent.MyMembership, membership);
  session.stop = () => { client.off(RoomEvent.Timeline, timeline); client.off(MatrixEventEvent.Decrypted, decrypted); client.off(RoomEvent.Redaction, timeline); client.off(RoomEvent.MyMembership, membership); };
  // Seed already decrypted history incrementally without delaying app startup.
  void (async () => { for (const room of client.getRooms()) { if (!isActive(session)) return; if (room.getMyMembership() !== 'join') { await enqueue(session, () => forgetRoom(session, room.roomId)); continue; } for (const event of room.getLiveTimeline().getEvents()) { if (!isActive(session)) return; await enqueue(session, () => indexEvent(session, event, room)); } } })();
}
export function resetSearch() { generation++; if (active) { const old = active; active = null; old.stop(); old.database.close(); } }
export async function searchIndexStatus() { const s = sessionRequired(); return { indexedCount: await requestResult(s.database.transaction('documents').objectStore('documents').count()), error: s.error, indexingRooms: [...s.history] }; }
const cursorOf = (doc: Pick<SearchDocument, 'timestamp' | 'id'>) => btoa(JSON.stringify([doc.timestamp, doc.id]));
function decodeCursor(value?: string): [number, string] | null { if (!value) return null; try { const p = JSON.parse(atob(value)); if (Array.isArray(p) && p.length === 2 && Number.isSafeInteger(p[0]) && typeof p[1] === 'string' && p[1].length < 300) return [p[0], p[1]]; } catch {} throw new Error('The search page cursor is invalid. Start a new search.'); }
async function candidates(s: SearchSession, firstTag: string | undefined, cursor: [number, string] | null, query: SearchQuery, count: number): Promise<StoredDocument[]> {
  const start = query.after ?? 0, end = Math.min(query.before === undefined ? Number.MAX_SAFE_INTEGER : query.before - 1, cursor?.[0] ?? Number.MAX_SAFE_INTEGER), upperId = cursor && cursor[0] === end ? cursor[1] : '\uffff';
  if (end < start) return [];
  const tx = s.database.transaction('documents'), index = tx.objectStore('documents').index(firstTag ? 'terms' : 'time'), range = firstTag ? IDBKeyRange.bound([firstTag, start], [firstTag, end, upperId], false, !!cursor && cursor[0] === end) : IDBKeyRange.bound([start], [end, upperId], false, !!cursor && cursor[0] === end);
  return new Promise((resolve, reject) => { const rows: StoredDocument[] = [], request = index.openCursor(range, 'prev'); request.onerror = () => reject(request.error); request.onsuccess = () => { const item = request.result; if (!item || rows.length >= count) { resolve(rows); return; } rows.push(item.value); item.continue(); }; });
}
export async function searchMessages(input: string, options: { limit?: number; cursor?: string; roomIds?: string[]; currentUser?: string; kind?: 'messages' | 'files'; signal?: AbortSignal } = {}) {
  const s = sessionRequired(), check = () => { options.signal?.throwIfAborted(); if (!isActive(s)) throw new Error('Your search session changed. Retry after signing in.'); };
  check();
  const query = parseSearchQuery(input), tags = await Promise.all(query.terms.map(term => searchTag(s.keys.search, term))), limit = Math.max(1, Math.min(100, options.limit || 50)), allowed = options.roomIds ? new Set(options.roomIds) : null, hits: SearchDocument[] = [], rooms = new Map<string, Room>();
  check();
  let cursor = decodeCursor(options.cursor), scanned = 0, more = false;
  while (scanned < 2000 && hits.length < limit) {
    check();
    const rows = await candidates(s, tags[0], cursor, query, Math.min(200, 2000 - scanned)); check(); if (!rows.length) { more = false; break; } more = true;
    for (const row of rows) {
      check(); cursor = [row.timestamp, row.id]; scanned++;
      const room = s.client.getRoom(row.roomId);
      if (room && joined(s, row.roomId) && (!allowed || allowed.has(row.roomId)) && tags.every(tag => row.tags.includes(tag))) {
        let doc: SearchDocument | undefined;
        try { doc = await openSearchDocument(row, s.keys); } catch { await removeDocument(s, row.id); }
        check();
        if (doc && s.client.getRoom(row.roomId) === room && joined(s, row.roomId)
            && !s.client.getIgnoredUsers().includes(doc.authorId) && !room.findEventById(doc.id)?.isRedacted()) {
          doc = { ...doc, roomName: room.name, authorName: room.getMember(doc.authorId)?.name || doc.authorName };
          const file = doc.has.includes('file');
          if ((!options.kind || (options.kind === 'files' ? file : !file)) && matchesSearch(doc, query, options.currentUser || s.actor || '')) { hits.push(doc); rooms.set(room.roomId, room); }
        }
      }
      if (hits.length >= limit || scanned >= 2000) break;
    }
    if (rows.length < 200 && hits.length < limit) { more = false; break; }
  }
  check(); const indexedCount = await requestResult(s.database.transaction('documents').objectStore('documents').count()); check();
  return { hits: hits.filter(doc => joined(s, doc.roomId) && s.client.getRoom(doc.roomId) === rooms.get(doc.roomId) && !s.client.getIgnoredUsers().includes(doc.authorId) && !rooms.get(doc.roomId)?.findEventById(doc.id)?.isRedacted()), nextCursor: more && cursor ? cursorOf({ timestamp: cursor[0], id: cursor[1] }) : null, indexedCount, scanned };
}
export async function indexRoomHistory(roomId: string, onProgress: (value: { roomId: string; indexed: number; complete: boolean }) => void = () => {}, signal?: AbortSignal, options: { cursor?: string; maxPages?: number } = {}) {
  const s = sessionRequired(), room = s.client.getRoom(roomId); if (!room || !joined(s, roomId)) throw new Error('Join this channel before indexing history.'); if (s.history.has(roomId)) throw new Error('This channel is already being indexed.'); s.history.add(roomId);
  if (options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 8192)) { s.history.delete(roomId); throw new Error('The history cursor is invalid. Start a new indexing run.'); }
  let indexed = 0, token: string | null = options.cursor ?? room.getLiveTimeline().getPaginationToken(Direction.Backward), complete = false, pages = 0;
  const maxPages = Math.max(1, Math.min(20, Math.floor(options.maxPages || 20)));
  const actor = s.client.getUserId(), device = s.client.getDeviceId();
  const cancelled = () => { if (signal?.aborted || !joined(s, roomId) || s.client.getRoom(roomId) !== room || s.client.getUserId() !== actor || s.client.getDeviceId() !== device) throw new Error(signal?.aborted ? 'History indexing cancelled. Indexed messages remain searchable.' : 'Your account or channel membership changed. History indexing stopped.'); };
  try {
    if (!options.cursor) for (const event of room.getLiveTimeline().getEvents()) { cancelled(); await indexEvent(s, event, room, cancelled); cancelled(); indexed++; } onProgress({ roomId, indexed, complete: false });
    const seen = new Set<string>();
    while (token && pages < maxPages) {
      cancelled(); seen.add(token);
      const page = await s.client.createMessagesRequest(roomId, token, 100, Direction.Backward); cancelled(); pages++;
      if (!Array.isArray(page.chunk) || page.chunk.length > 100) throw new Error('The homeserver returned an invalid history page.');
      for (const raw of page.chunk) {
        cancelled();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.room_id !== undefined && raw.room_id !== roomId) throw new Error('The homeserver returned history for an unexpected conversation.');
        // /messages events may omit room_id. Bind them to the requested room
        // before mapping/decryption, without overwriting a conflicting identity.
        const event = s.client.getEventMapper()({ ...raw, room_id: roomId });
        await indexEvent(s, event, room, cancelled); cancelled(); indexed++;
      }
      onProgress({ roomId, indexed, complete: false }); cancelled();
      // Empty filtered pages can still lead to accessible older events.
      // Only an omitted end token establishes the end of this scan.
      if (page.end === undefined) { token = null; break; }
      if (typeof page.end !== 'string' || !page.end || seen.has(page.end)) throw new Error('History pagination stopped advancing. Indexed messages remain searchable; retry after checking your homeserver.');
      token = page.end;
    }
    cancelled(); complete = token === null; onProgress({ roomId, indexed, complete }); return { indexed, complete, ...(token ? { nextCursor: token } : {}) };
  } finally { s.history.delete(roomId); }
}
export async function clearSearchIndex() { const s = sessionRequired(); await s.queue; if (!isActive(s)) throw new Error('Your search session changed. Reopen search before clearing it.'); const tx = s.database.transaction('documents', 'readwrite'); tx.objectStore('documents').clear(); await transactionDone(tx); }
