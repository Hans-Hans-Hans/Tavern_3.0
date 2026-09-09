import { Direction, type MatrixEvent } from 'matrix-js-sdk';
import { getMatrixClient } from './matrix';
export type WorkKind = 'task' | 'note' | 'event' | 'poll';
export type WorkItem = { id: string; revision: string; author: string; at: number; kind: WorkKind; title: string; text: string; status: 'todo' | 'doing' | 'done'; assignee: string; due: string; options: string[]; votes: Record<string, number | number[]>; multiple: boolean; closesAt: number; closed: boolean };
const namespace = 'io.tavern.collaboration';
function context(roomId: string) { const c = getMatrixClient(), room = c?.getRoom(roomId); if (!c || !room || room.getMyMembership() !== 'join') throw new Error('Join this conversation first.'); return { c, room }; }
const clean = (v: unknown, max = 16000) => typeof v === 'string' ? v.slice(0, max) : '';
export function projectWork(events: MatrixEvent[]): WorkItem[] {
  const items = new Map<string, WorkItem>();
  for (const event of [...events].sort((a,b) => a.getTs()-b.getTs() || (a.getId() || '').localeCompare(b.getId() || ''))) {
    if (!event.isEncrypted() || event.isRedacted() || event.isDecryptionFailure()) continue;
    const p = event.getContent()[namespace], id = event.getId(), author = event.getSender();
    if (!id || !author || !p || p.version !== 1) continue;
    if (p.operation === 'create' && ['task','note','event','poll'].includes(p.kind)) {
      items.set(id, { id, revision: id, author, at: event.getTs(), kind: p.kind, title: clean(p.title,160), text: clean(p.text), status: 'todo', assignee: clean(p.assignee,255), due: clean(p.due,40), options: Array.isArray(p.options) ? p.options.filter((x:unknown)=>typeof x==='string').slice(0,10).map((x:string)=>x.slice(0,200)) : [], votes: {}, multiple: p.multiple === true, closesAt: Number.isSafeInteger(p.closesAt) && p.closesAt > event.getTs() ? p.closesAt : 0, closed: false });
    } else {
      const item = items.get(p.root); if (!item) continue;
      if (p.operation === 'vote' && item.kind === 'poll') {
        const choices = Array.isArray(p.choices) ? [...new Set(p.choices)] : [p.choice];
        if (!item.closed && (!item.closesAt || event.getTs() < item.closesAt) && choices.length <= (item.multiple ? item.options.length : 1) && choices.every(choice=>Number.isInteger(choice) && choice >= 0 && choice < item.options.length)) {
          if (!choices.length) delete item.votes[author]; else item.votes[author] = item.multiple ? choices as number[] : choices[0] as number;
        }
        continue;
      }
      // Content edits have one author, preventing an arbitrary member from rewriting a note or poll.
      // Task assignees may update only their own task's progress.
      if (p.revision !== item.revision) continue;
      if (p.operation === 'status' && item.kind === 'task' && (author === item.author || author === item.assignee) && ['todo','doing','done'].includes(p.status)) item.status = p.status;
      else if (author !== item.author) continue;
      else if (p.operation === 'close' && item.kind === 'poll') item.closed = true;
      else if (p.operation === 'edit' && item.kind !== 'poll') { item.title = clean(p.title,160); item.text = clean(p.text); }
      else if (p.operation === 'archive') { items.delete(item.id); continue; }
      else continue;
      item.revision = id;
    }
  }
  return [...items.values()].sort((a,b)=>b.at-a.at);
}
export async function getWork(roomId: string) {
  const { c, room } = context(roomId), events = room.getLiveTimeline().getEvents();
  await Promise.all(events.filter(e=>e.isEncrypted()).map(e=>c.decryptEventIfNeeded(e).catch(()=>{})));
  return { items: projectWork(events), hasMore: !!room.getLiveTimeline().getPaginationToken(Direction.Backward) };
}
async function send(roomId: string, body: string, payload: object) {
  const { c, room } = context(roomId);
  if (!await c.getCrypto()?.isEncryptionEnabledInRoom(room.roomId)) throw new Error('Collaboration requires an encrypted conversation.');
  return c.sendMessage(roomId, { msgtype: 'm.text', body, [namespace]: { version: 1, ...payload } } as any);
}
export async function createWork(roomId: string, value: { kind: WorkKind; title: string; text: string; assignee: string; due: string; options: string[]; multiple?: boolean; closesAt?: number }) {
  if (!value.title.trim() || value.title.length > 160 || value.text.length > 16000) throw new Error('Use a title up to 160 characters and content up to 16,000 characters.');
  if (value.kind === 'poll' && (value.options.length < 2 || value.options.length > 10 || new Set(value.options).size !== value.options.length)) throw new Error('Polls need 2–10 distinct answers.');
  if (value.closesAt && (!Number.isSafeInteger(value.closesAt) || value.closesAt <= Date.now())) throw new Error('Poll expiration must be in the future.');
  if (value.assignee && context(roomId).room.getMember(value.assignee)?.membership !== 'join') throw new Error('Assign tasks to a joined member.');
  return send(roomId, `${value.kind.toUpperCase()}: ${value.title}\n${value.text}${value.kind==='poll'?'\n'+value.options.map((x,i)=>`${i+1}. ${x}`).join('\n'):''}`, { operation:'create', ...value });
}
export async function updateWork(roomId: string, item: WorkItem, operation: 'status' | 'vote' | 'close' | 'edit' | 'archive', data: Record<string, unknown> = {}) {
  const current = (await getWork(roomId)).items.find(x=>x.id===item.id);
  if (!current || current.revision !== item.revision) throw new Error('This item changed. Review the latest version and retry.');
  if (operation === 'vote') {
    const choices = Array.isArray(data.choices) ? [...new Set(data.choices)] : [data.choice];
    if (current.kind !== 'poll' || pollClosed(current)) throw new Error('This poll is closed.');
    if (choices.length > (current.multiple ? current.options.length : 1) || choices.some(choice=>!Number.isInteger(choice) || Number(choice) < 0 || Number(choice) >= current.options.length)) throw new Error('Choose a valid poll answer.');
  }
  const me = context(roomId).c.getUserId();
  if (operation !== 'vote' && current.author !== me && !(operation==='status' && current.assignee===me)) throw new Error('Only the author can edit this item; an assignee can update task progress.');
  return send(roomId, `${operation}: ${item.title}${operation==='edit'?'\n'+clean(data.text):''}`, { ...data, operation, root:item.id, revision:item.revision });
}
export async function loadWorkHistory(roomId: string) { const { c, room } = context(roomId); await c.scrollback(room,100); }
export function calendarDownload(item: WorkItem) {
  if (!item.due || !Number.isFinite(Date.parse(item.due))) throw new Error('Set an event date first.');
  const escape = (s: string) => s.replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/[,;]/g,'\\$&');
  const date = new Date(item.due).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const content = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Tavern//Calendar//EN','BEGIN:VEVENT',`UID:${escape(item.id)}@tavern`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')}`,`DTSTART:${date}`,`SUMMARY:${escape(item.title)}`,`DESCRIPTION:${escape(item.text)}`,'END:VEVENT','END:VCALENDAR',''].join('\r\n');
  const url=URL.createObjectURL(new Blob([content],{type:'text/calendar'})),a=document.createElement('a');a.href=url;a.download='tavern-event.ics';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function pollClosed(item: WorkItem, now = Date.now()) { return item.closed || !!item.closesAt && item.closesAt <= now; }
export function pollSelections(item: WorkItem, userId: string) { const vote = item.votes[userId]; return Array.isArray(vote) ? vote : typeof vote === 'number' ? [vote] : []; }
