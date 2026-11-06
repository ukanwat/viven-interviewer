// Everything about one person: memory, text turns, reports, live calls. Runs serially, so one
// person is never driven by two brains at once. The server keeps one Room per person in a map.
import * as brain from './brain/brain.ts';
import { personId } from './brain/ids.ts';
import { sessionReport } from './brain/report.ts';
import { lookUp } from './brain/lookup.ts';
import { consolidate, notesMarkdown } from './brain/notes.ts';
import * as sources from './brain/sources.ts';
import type { Person } from './brain/types.ts';
import { startCall, publicPerson, type CallHandle, type Connect } from './voice/live.ts';

export type PersonStore = {
  load(id: string): Promise<Person | undefined>;
  save(p: Person): void; // fire-and-forget; the platform makes it durable
};

type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const err = (status: number, error: string): Reply => ({ status, body: { error } });

export class Room {
  id: string;
  private store: PersonStore;
  private connect: Connect;
  private person?: Person;
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  private active?: CallHandle; // the live call, if any, so new context can reach it

  constructor(id: string, store: PersonStore, connect: Connect) {
    this.id = id;
    this.store = store;
    this.connect = connect;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private async get(): Promise<Person | undefined> {
    if (!this.loaded) {
      this.person = await this.store.load(this.id);
      this.loaded = true;
      // Records from before notes existed: write their notes from what they said.
      if (this.person && brain.needsNotes(this.person)) {
        const p = this.person;
        await consolidate(p, { sessionId: p.sessions.at(-1)?.id ?? 'rebuild', turns: p.turns, fromScratch: true }).catch((e) => console.error('rebuild failed', (e as Error).message));
        this.save();
      }
    }
    return this.person;
  }

  private async getOrCreate(name: string, topic = '', golden?: string[], link?: string): Promise<Person> {
    let p = await this.get();
    if (!p) p = this.person = brain.newPerson(name, topic);
    else if (topic && !p.topicHint) p.topicHint = topic;
    if (golden?.length) p.sealedGolden = golden;
    if (link) await lookUp(p, link).catch((e) => console.error('lookup failed', (e as Error).message));
    // Keep what their tools show up to date: re-read in the background on a later visit.
    for (const c of p.connections ?? []) if (c.status === 'ready' && Date.now() - (c.lastRead ?? 0) > sources.STALE_MS) this.readSource(p, c);
    return p;
  }

  // Runs beside the conversation (it can take a minute); saves as notes land.
  private readSource(p: Person, c: NonNullable<Person['connections']>[number]) {
    if (c.status === 'reading' && c.lastRead && Date.now() - c.lastRead < 60_000) return;
    void sources
      .read(p, c, { onChange: () => this.save() })
      .then(() => {
        this.save();
        const src = sources.renderSources(p, 4000);
        if (this.active && src) this.active.note(`New context (silent, not said by them): ${p.name} connected ${c.label}, and an assistant read it. What it shows (NOT said by them; ask about the why when it fits, say where you saw it; don't interrupt what they're saying):\n${src}`);
      })
      .catch((e) => console.error('source read failed', (e as Error).message));
  }

  private save() {
    if (this.person) this.store.save(this.person);
  }

  // JSON API for one person. `route` is the part after /api/.
  async api(route: string, b: any): Promise<Reply> {
    if (route === 'person') {
      const p = await this.get();
      return p ? ok(publicPerson(p)) : err(404, 'not found');
    }
    if (route === 'notes.md') {
      const p = await this.get();
      return p ? ok(notesMarkdown(p)) : err(404, 'not found');
    }
    if (route === 'connect/finish') {
      const p = await this.get();
      if (!p) return err(404, 'not found');
      try {
        const c = await sources.finishConnect(p, String(b.state ?? ''), String(b.code ?? ''));
        this.save();
        this.readSource(p, c);
        return ok({ name: p.name, label: c.label });
      } catch (e) {
        this.save();
        return err(400, (e as Error).message);
      }
    }
    if (route === 'lookup') {
      const p = await this.get();
      return ok(p ? { returning: brain.isReturning(p), person: publicPerson(p) } : { returning: false });
    }
    return this.serial(async () => {
      if (route === 'text/start') {
        if (!b.name?.trim() || personId(b.name) !== this.id) return err(400, 'name required');
        const p = await this.getOrCreate(b.name, b.topic, b.golden, b.link);
        const s = brain.startSession(p, 'text');
        const d = await brain.opener(p, s.id, 'text');
        this.save();
        return ok({ sessionId: s.id, decision: d, person: publicPerson(p) });
      }
      if (route === 'connect/start') {
        if (!b.name?.trim() || personId(b.name) !== this.id) return err(400, 'name required');
        const p = await this.getOrCreate(b.name);
        const url = await sources.startConnect(p, String(b.server ?? ''), String(b.redirectUri ?? '')).catch((e) => e as Error);
        this.save();
        return url instanceof Error ? err(400, url.message) : ok({ url });
      }
      const p = await this.get();
      if (!p) return err(404, 'not found');
      if (route === 'sources/strike') {
        sources.strike(p, String(b.path ?? ''));
        this.save();
        return ok({ person: publicPerson(p) });
      }
      if (route === 'connect/remove') {
        sources.disconnect(p, String(b.connection ?? ''));
        this.save();
        return ok({ person: publicPerson(p) });
      }
      if (route === 'connect/refresh') {
        const c = p.connections?.find((x) => x.id === b.connection && x.tokens);
        if (!c) return err(404, 'not connected');
        this.readSource(p, c);
        return ok({ person: publicPerson(p) });
      }
      if (route === 'text/turn') {
        const text = String(b.text ?? '').slice(0, 4000);
        if (!text.trim()) return err(400, 'empty');
        const t0 = Date.now();
        const d = await brain.personTurn(p, text, 'text', b.sessionId);
        if (d.move === 'wrap') brain.endSession(p, b.sessionId, 'later');
        this.save();
        if (p.turns.filter((t) => t.role === 'person').length % 4 === 0)
          void this.serial(async () => {
            await brain.refreshSummary(p);
            this.save();
          }).catch(() => {});
        return ok({ decision: d, ms: Date.now() - t0, person: publicPerson(p) });
      }
      if (route === 'text/end') {
        brain.endSession(p, b.sessionId, b.reason ?? 'later');
        await consolidate(p, { sessionId: b.sessionId }).catch((e) => console.error('after-call notes failed', (e as Error).message));
        await brain.refreshSummary(p).catch(() => {});
        this.save();
        return ok({ person: publicPerson(p) });
      }
      if (route === 'report') {
        const r = await sessionReport(p, b.sessionId);
        p.reports = [...(p.reports ?? []).filter((x) => x.sessionId !== (b.sessionId ?? 'all')), { sessionId: b.sessionId ?? 'all', at: Date.now(), report: r }];
        this.save();
        return ok({ report: r });
      }
      return err(404, 'unknown route');
    });
  }

  // One voice call over a browser socket. Returns handlers for the socket's messages and close.
  call(notify: (e: Record<string, unknown>) => void, closeBrowser: () => void) {
    let handle: CallHandle | undefined;
    const room = this;
    const saver = { save: () => room.save() };
    return {
      async message(raw: string) {
        let m: any;
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        if (m.type === 'start' && !handle) {
          if (!m.name?.trim() || !m.sdp || personId(m.name) !== room.id) return notify({ type: 'error', message: 'name and offer required' });
          try {
            const p = await room.getOrCreate(m.name, m.topic, m.golden, m.link);
            const c = await startCall({ store: saver, connect: room.connect, person: p, offerSdp: m.sdp, voice: m.voice, notify });
            handle = c.handle;
            room.active = c.handle;
            notify({ type: 'answer', sdp: c.answerSdp, sessionId: c.sessionId, personId: p.id });
          } catch (e) {
            console.error('call start failed', (e as Error).message);
            notify({ type: 'error', message: (e as Error).message });
            closeBrowser();
          }
        } else if (m.type === 'hangup') {
          if (room.active === handle) room.active = undefined;
          await handle?.hangup(m.reason ?? 'later');
        }
        else if (m.type === 'typed' && typeof m.text === 'string') handle?.typed(m.text.slice(0, 4000));
      },
      close() {
        if (room.active === handle) room.active = undefined;
        void handle?.hangup('browser_closed');
      },
    };
  }
}

// The row the people list shows.
export function personRow(p: Person) {
  const people = p.turns.filter((t) => t.role === 'person').length;
  return { id: p.id, name: p.name, updatedAt: p.updatedAt ?? Date.now(), turns: people, items: Object.keys(p.notes ?? {}).length, sessions: p.sessions.length, summary: p.summary ?? '' };
}
