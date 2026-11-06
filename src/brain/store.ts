import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Person } from './types.ts';

// One JSON file per person. Simple to inspect, diff and hand to the eval harness.
const DIR = process.env.DATA_DIR ?? join(import.meta.dirname, '../../data/people');
mkdirSync(DIR, { recursive: true });

export function personId(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'anonymous'
  );
}

export class Store {
  dir: string;
  constructor(dir = DIR) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  private path(id: string) {
    return join(this.dir, `${id}.json`);
  }
  get(id: string): Person | undefined {
    const p = this.path(id);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf8')) as Person;
  }
  save(person: Person) {
    person.updatedAt = Date.now();
    const p = this.path(person.id);
    writeFileSync(p + '.tmp', JSON.stringify(person, null, 2));
    renameSync(p + '.tmp', p);
  }
  list(): Person[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Person);
  }
}

// In-memory store for eval runs (no disk writes, isolated per run).
export class MemoryStore extends Store {
  private m = new Map<string, Person>();
  constructor() {
    super(join(import.meta.dirname, '../../data/.mem'));
  }
  override get(id: string) {
    const p = this.m.get(id);
    return p ? (structuredClone(p) as Person) : undefined;
  }
  override save(person: Person) {
    person.updatedAt = Date.now();
    this.m.set(person.id, structuredClone(person));
  }
  override list() {
    return [...this.m.values()];
  }
}
