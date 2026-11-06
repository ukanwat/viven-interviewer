// People and their conversations in Postgres (any provider: Neon, Supabase, RDS, local).
// One row per person: list columns plus their whole memory as JSON.
import postgres from 'postgres';
import { personRow } from '../room.ts';
import type { Person } from './types.ts';

export class PgStore {
  private sql: postgres.Sql;
  private ready: Promise<unknown>;
  private pending = new Map<string, Person>(); // latest unsaved state per person
  private writing?: Promise<void>;

  constructor(url: string) {
    this.sql = postgres(url, { max: 5, onnotice: () => {} });
    this.ready = this.sql`
      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        turns INT NOT NULL DEFAULT 0,
        items INT NOT NULL DEFAULT 0,
        sessions INT NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        data JSONB NOT NULL
      )`;
  }

  async load(id: string): Promise<Person | undefined> {
    await this.ready;
    if (this.pending.has(id)) return structuredClone(this.pending.get(id)) as Person;
    const [r] = await this.sql`SELECT data FROM people WHERE id = ${id}`;
    return r?.data as Person | undefined;
  }

  // Saves happen every turn: one writer, always writing each person's latest state.
  save(p: Person) {
    p.updatedAt = Date.now();
    this.pending.set(p.id, structuredClone(p) as Person);
    this.writing ??= this.flush().finally(() => (this.writing = undefined));
  }

  private async flush() {
    await this.ready;
    while (this.pending.size) {
      const [id, p] = this.pending.entries().next().value!;
      this.pending.delete(id);
      const r = personRow(p);
      try {
        await this.sql`
          INSERT INTO people (id, name, updated_at, turns, items, sessions, summary, data)
          VALUES (${r.id}, ${r.name}, ${r.updatedAt}, ${r.turns}, ${r.items}, ${r.sessions}, ${r.summary}, ${this.sql.json(p as any)})
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, turns = excluded.turns,
            items = excluded.items, sessions = excluded.sessions, summary = excluded.summary, data = excluded.data`;
      } catch (e) {
        console.error('save failed', (e as Error).message);
        if (!this.pending.has(id)) this.pending.set(id, p); // retry on the next save
        return;
      }
    }
  }

  async list() {
    await this.ready;
    const rows = await this.sql`SELECT id, name, updated_at, turns, items, sessions, summary FROM people ORDER BY updated_at DESC LIMIT 500`;
    return rows.map((r) => ({ id: r.id, name: r.name, updatedAt: Number(r.updated_at), turns: r.turns, items: r.items, sessions: r.sessions, summary: r.summary }));
  }
}
