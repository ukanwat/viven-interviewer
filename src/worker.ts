// Cloudflare Workers entry: a thin adapter over the same Room/brain/voice code the Node server runs.
// One Durable Object per person (serial, holds live calls); people and chats in D1 (SQLite).
import { PRESETS } from './brain/mcp.ts';
import { DurableObject } from 'cloudflare:workers';
import { Room, personRow } from './room.ts';
import { personId } from './brain/ids.ts';
import { MODELS } from './brain/llm.ts';
import type { Connect } from './voice/live.ts';
import type { Person } from './brain/types.ts';
import { connectedPage } from './brain/connected-page.ts';

type Env = { DB: D1Database; ROOMS: DurableObjectNamespace<PersonRoom>; ASSETS: Fetcher; PASSCODE?: string };

const SCHEMA = `CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0, items INTEGER NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '', data TEXT NOT NULL)`;

// Same shape as the Postgres store: one row per person, list columns plus their memory as JSON.
class D1Store {
  private db: D1Database;
  private ready?: Promise<unknown>;
  private pending = new Map<string, Person>();
  private writing?: Promise<void>;
  constructor(db: D1Database) {
    this.db = db;
  }
  private init() {
    return (this.ready ??= this.db.prepare(SCHEMA).run());
  }
  async load(id: string) {
    await this.init();
    if (this.pending.has(id)) return structuredClone(this.pending.get(id)) as Person;
    const r = await this.db.prepare('SELECT data FROM people WHERE id = ?').bind(id).first<{ data: string }>();
    return r ? (JSON.parse(r.data) as Person) : undefined;
  }
  save(p: Person) {
    p.updatedAt = Date.now();
    this.pending.set(p.id, structuredClone(p) as Person);
    this.writing ??= this.flush().finally(() => (this.writing = undefined));
  }
  private async flush() {
    await this.init();
    while (this.pending.size) {
      const [id, p] = this.pending.entries().next().value!;
      this.pending.delete(id);
      const r = personRow(p);
      try {
        await this.db
          .prepare(
            `INSERT INTO people (id, name, updated_at, turns, items, sessions, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, turns = excluded.turns,
             items = excluded.items, sessions = excluded.sessions, summary = excluded.summary, data = excluded.data`,
          )
          .bind(r.id, r.name, r.updatedAt, r.turns, r.items, r.sessions, r.summary, JSON.stringify(p))
          .run();
      } catch (e) {
        console.error('save failed', (e as Error).message);
        if (!this.pending.has(id)) this.pending.set(id, p);
        return;
      }
    }
  }
}

async function listPeople(db: D1Database) {
  await db.prepare(SCHEMA).run();
  const { results } = await db.prepare('SELECT id, name, updated_at, turns, items, sessions, summary FROM people ORDER BY updated_at DESC LIMIT 500').all<any>();
  return results.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at, turns: r.turns, items: r.items, sessions: r.sessions, summary: r.summary }));
}

// Outbound WebSocket to the Live sideband, in the Socket shape live.ts expects.
const connect: Connect = async (url, headers) => {
  const res = await fetch(url.replace(/^wss:/, 'https:'), { headers: { ...headers, Upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`sideband upgrade failed (HTTP ${res.status})`);
  ws.accept();
  return {
    send: (d) => ws.readyState === WebSocket.OPEN && ws.send(d),
    close: () => ws.close(),
    onMessage: (cb) => ws.addEventListener('message', (e) => cb(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer))),
    onClose: (cb) => ws.addEventListener('close', () => cb()),
  };
};

export class PersonRoom extends DurableObject<Env> {
  private room?: Room;
  private store: D1Store;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new D1Store(env.DB);
  }

  async fetch(req: Request): Promise<Response> {
    const id = req.headers.get('x-person-id') ?? '';
    this.room ??= new Room(id, this.store, connect);
    if (req.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      const call = this.room.call(
        (e) => server.readyState === WebSocket.OPEN && server.send(JSON.stringify(e)),
        () => server.close(),
      );
      server.addEventListener('message', (e) => void call.message(String(e.data)));
      server.addEventListener('close', () => call.close());
      return new Response(null, { status: 101, webSocket: client });
    }
    const { route, body } = await req.json<{ route: string; body: unknown }>();
    const r = await this.room.api(route, body);
    return Response.json(r.body, { status: r.status });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const toRoom = (id: string, init: RequestInit) => {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      const headers = new Headers(init.headers);
      headers.set('x-person-id', id);
      return stub.fetch('https://room/', { ...init, headers });
    };
    const api = (id: string, route: string, body: unknown = {}) => toRoom(id, { method: 'POST', body: JSON.stringify({ route, body }) });

    if (path !== '/ws' && !path.startsWith('/api/')) return env.ASSETS.fetch(req);
    // The sign-in redirect from a tool they connect: no passcode (it comes from the tool), the state names the person.
    if (path === '/api/oauth/callback') {
      const state = url.searchParams.get('state') ?? '';
      const id = state.split('.')[0];
      const fail = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      if (!id || fail) return connectedPage(false, fail ?? 'Sign-in was cancelled.');
      const r = await api(id, 'connect/finish', { state, code: url.searchParams.get('code') ?? '' });
      const j: any = await r.json();
      return connectedPage(r.ok, r.ok ? j.label : j.error);
    }
    if (env.PASSCODE && req.headers.get('x-passcode') !== env.PASSCODE && url.searchParams.get('code') !== env.PASSCODE)
      return Response.json({ error: 'passcode required' }, { status: 401 });

    try {
      if (path === '/ws') {
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
        return toRoom(personId(url.searchParams.get('name') ?? ''), { headers: req.headers });
      }
      if (path === '/api/status') return Response.json({ models: MODELS, tools: PRESETS });
      if (path === '/api/people') return Response.json({ people: await listPeople(env.DB) });
      if (path.startsWith('/api/person/')) return api(decodeURIComponent(path.slice('/api/person/'.length)), 'person');
      if (path === '/api/connect') {
        const r = await api(personId(url.searchParams.get('name') ?? ''), 'connect/start', { name: url.searchParams.get('name') ?? '', server: url.searchParams.get('server') ?? '', redirectUri: `${url.origin}/api/oauth/callback` });
        const j: any = await r.json();
        return r.ok ? Response.redirect(j.url, 302) : connectedPage(false, j.error);
      }
      if (path === '/api/lookup') return api(personId(url.searchParams.get('name') ?? ''), 'lookup');
      if (req.method === 'POST') {
        const b: any = await req.json();
        const id = path === '/api/text/start' ? personId(b.name ?? '') : String(b.id ?? '');
        if (!id) return Response.json({ error: 'id required' }, { status: 400 });
        return api(id, path.slice('/api/'.length), b);
      }
      return Response.json({ error: 'unknown route' }, { status: 404 });
    } catch (e) {
      console.error('api error', path, (e as Error).message);
      return Response.json({ error: 'Something went wrong on the server. Try again.' }, { status: 500 });
    }
  },
};
