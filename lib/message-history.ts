import { Direction, RoomEvent, TimelineWindow, type EventTimeline, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';

const PAGE = 50, WINDOW = 500, SEGMENTS = 32, DEADLINE = 20_000;
export type MessageHistorySnapshot<T> = {
  messages: T[]; older: boolean; newer: boolean; atLive: boolean;
  limited: boolean; targetPresent: boolean; emptyPage: boolean;
};
type Options<T> = { client: MatrixClient; room: Room; eventId: string; current: () => boolean; project: (events: MatrixEvent[]) => T[] };
type Graph = Map<EventTimeline, [EventTimeline | null, EventTimeline | null]>;

/** A disposable view over the SDK's context and bidirectional room timelines.
 * SDK room caches remain owned by the Matrix client; this view retains at most
 * 500 events. Initial context can fetch one page on each side; subsequent
 * explicit pagination makes at most one request. */
export class JoinedMessageHistory<T> {
  private readonly set;
  private readonly window: TimelineWindow;
  private readonly removeListeners: () => void;
  private readonly actor: string | null;
  private readonly device: string | null;
  private readonly homeserver: string;
  private readonly controller = new AbortController();
  private pending = false;
  private loaded = false;
  private closed = false;
  private forwardEnd: { timeline: EventTimeline; token: string | null; length: number } | null = null;
  private readonly pages = { older: 0, newer: 0 };
  private readonly seenCursors = new Map<EventTimeline, Map<Direction, Set<string>>>();

  constructor(private readonly options: Options<T>) {
    const { client, room, eventId } = options;
    if (!/^\$[^\s\x00-\x1f\x7f]{1,4095}$/.test(eventId)) throw new Error('Choose a valid message to open its context.');
    this.set = room.getUnfilteredTimelineSet();
    this.actor = client.getUserId(); this.device = client.getDeviceId(); this.homeserver = client.getHomeserverUrl();
    this.check();
    // SDK 42.3's TimelineWindow registers a bound room listener but exposes no
    // destructor. Capture only the listener synchronously added by this instance.
    const before = new Set(room.listeners(RoomEvent.Timeline));
    this.window = new TimelineWindow(client, this.set, { windowLimit: WINDOW });
    const owned = room.listeners(RoomEvent.Timeline).filter(listener => !before.has(listener));
    this.removeListeners = () => { for (const listener of owned) room.off(RoomEvent.Timeline, listener as (...args: any[]) => void); };
  }

  dispose() {
    if (this.closed) return;
    this.closed = true; this.controller.abort(); this.removeListeners(); this.seenCursors.clear();
  }
  private check() {
    const { client, room, current } = this.options;
    if (this.closed || !current() || client.getUserId() !== this.actor || client.getDeviceId() !== this.device || client.getHomeserverUrl() !== this.homeserver || client.getRoom(room.roomId) !== room || room.getMyMembership() !== 'join' || room.getUnfilteredTimelineSet() !== this.set)
      throw new Error('Your account or conversation access changed. Reopen the message.');
  }
  /** Check reciprocal scope before calling SDK window iteration, which assumes
   * an acyclic chain. Do not replace the SDK's timeline or cursor ownership. */
  private graph(): Graph {
    this.check();
    const result: Graph = new Map(), seeds = [this.window.getTimelineIndex(Direction.Backward)?.timeline, this.window.getTimelineIndex(Direction.Forward)?.timeline].filter(Boolean) as EventTimeline[];
    for (const seed of seeds) for (const direction of [Direction.Backward, Direction.Forward]) {
      const seen = new Set<EventTimeline>(); let timeline: EventTimeline | null = seed;
      while (timeline) {
        if (seen.has(timeline) || timeline.getRoomId() !== this.options.room.roomId || timeline.getTimelineSet() !== this.set || !this.set.getTimelines().includes(timeline)) throw new Error('The message timeline changed. Reopen its context.');
        seen.add(timeline);
        if (!result.has(timeline) && result.size >= SEGMENTS) throw new Error('This context exceeds 32 connected history segments. Reopen a message nearer the history you want.');
        const older = timeline.getNeighbouringTimeline(Direction.Backward), newer = timeline.getNeighbouringTimeline(Direction.Forward);
        if (older && older.getNeighbouringTimeline(Direction.Forward) !== timeline || newer && newer.getNeighbouringTimeline(Direction.Backward) !== timeline) throw new Error('The message timeline changed. Reopen its context.');
        for (const dir of [Direction.Backward, Direction.Forward]) {
          const token = timeline.getPaginationToken(dir);
          if (token !== null && (typeof token !== 'string' || !token || token.length > 8192)) throw new Error('The homeserver returned an invalid history cursor.');
        }
        result.set(timeline, [older, newer]); timeline = direction === Direction.Backward ? older : newer;
      }
    }
    return result;
  }
  private sameGraph(previous: Graph) {
    const next = this.graph();
    if (next.size !== previous.size || [...previous].some(([timeline, links]) => !next.has(timeline) || next.get(timeline)!.some((link, index) => link !== links[index]))) throw new Error('The message timeline changed while reading. Reopen its context.');
  }
  private async run<R>(action: () => Promise<R>): Promise<R> {
    this.check(); if (this.pending) throw new Error('Wait for this history request to finish.');
    this.pending = true;
    let timer: ReturnType<typeof setTimeout>, poll: ReturnType<typeof setInterval>, abort: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('Message context closed.', 'AbortError'));
      this.controller.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { reject(new Error('Message history did not finish within 20 seconds. Reopen the message to retry.')); this.dispose(); }, DEADLINE);
      poll = setInterval(() => { try { this.check(); } catch (error) { reject(error); this.dispose(); } }, 250);
    });
    try { const value = await Promise.race([action(), stopped]); this.check(); return value; }
    finally { clearTimeout(timer!); clearInterval(poll!); this.controller.signal.removeEventListener('abort', abort!); this.pending = false; }
  }
  private async snapshot(emptyPage = false): Promise<MessageHistorySnapshot<T>> {
    const graph = this.graph(), events = this.window.getEvents();
    if (events.length > WINDOW || events.some(event => !event || event.getRoomId() !== this.options.room.roomId)) throw new Error('This history window is invalid. Reopen the message.');
    for (let index = 0; index < events.length; index += 8) {
      await Promise.all(events.slice(index, index + 8).filter(event => event.isEncrypted()).map(event => this.options.client.decryptEventIfNeeded(event).catch(() => {})));
      this.check(); this.sameGraph(graph);
    }
    const end = this.window.getTimelineIndex(Direction.Forward)!, endTimeline = end.timeline;
    const atLive = endTimeline === this.set.getLiveTimeline() && end.index + endTimeline.getBaseIndex() >= endTimeline.getEvents().length;
    const forwardEnded = this.forwardEnd?.timeline === endTimeline && this.forwardEnd.token === endTimeline.getPaginationToken(Direction.Forward) && this.forwardEnd.length === endTimeline.getEvents().length;
    this.check(); this.sameGraph(graph);
    const messages = this.options.project(events);
    this.check(); this.sameGraph(graph);
    return { messages, older: this.window.canPaginate(Direction.Backward), newer: !atLive && !forwardEnded && this.window.canPaginate(Direction.Forward), atLive, limited: events.length >= WINDOW, targetPresent: events.some(event => event.getId() === this.options.eventId), emptyPage };
  }
  load() {
    return this.run(async () => {
      await this.window.load(this.options.eventId, PAGE); this.check(); this.graph();
      const events = this.window.getEvents();
      if (!events.some(event => event.getId() === this.options.eventId && event.getRoomId() === this.options.room.roomId)) throw new Error('The requested message is unavailable in this history.');
      // The pinned SDK requests /context?limit=0. Populate a small surrounding
      // window through its normal pagination APIs, without an unbounded loop.
      if (events.length === 1) for (const direction of [Direction.Backward, Direction.Forward]) {
        if (this.window.canPaginate(direction)) { await this.window.paginate(direction, PAGE / 2, true, 1); this.check(); this.graph(); }
      }
      const result = await this.snapshot();
      const target = this.window.getEvents().find(event => event.getId() === this.options.eventId)!;
      if (!target || target.isState() || target.getType() !== 'm.room.message' && !target.isEncrypted() || ['m.thread', 'm.replace'].includes(target.getRelation()?.rel_type || '')) throw new Error('Choose an original conversation message to open its context.');
      this.loaded = true; return result;
    });
  }
  refresh() { return this.run(async () => { if (!this.loaded) throw new Error('Open this message context first.'); return this.snapshot(); }); }
  page(direction: 'older' | 'newer') {
    return this.run(async () => {
      if (!this.loaded) throw new Error('Open this message context first.');
      const dir = direction === 'older' ? Direction.Backward : Direction.Forward;
      this.graph();
      // First extend through already cached neighbours without a network read.
      if (await this.window.paginate(dir, PAGE, false, 0)) { this.check(); return this.snapshot(); }
      this.check(); this.graph();
      const edge = this.window.getTimelineIndex(dir)!, timeline = edge.timeline, token = timeline.getPaginationToken(dir);
      if (!token) return this.snapshot();
      let cursors = this.seenCursors.get(timeline); if (!cursors) { cursors = new Map(); this.seenCursors.set(timeline, cursors); }
      let seen = cursors.get(dir); if (!seen) { seen = new Set(); cursors.set(dir, seen); }
      if (seen.has(token)) throw new Error('The homeserver repeated a history cursor. Reopen the context to retry.');
      if (this.pages[direction] >= 200) throw new Error('Loaded 200 pages in this direction. Reopen a message nearer the history you want.');
      const length = timeline.getEvents().length;
      const advanced = await this.window.paginate(dir, PAGE, true, 1); this.check(); this.graph();
      seen.add(token); this.pages[direction]++;
      const next = this.window.getTimelineIndex(dir)!;
      if (dir === Direction.Forward && !advanced && next.timeline === timeline && timeline.getPaginationToken(dir) === token && timeline.getEvents().length === length) this.forwardEnd = { timeline, token, length };
      else this.forwardEnd = null;
      return this.snapshot(!advanced);
    });
  }
}
