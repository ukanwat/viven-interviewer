// People and their conversations in any S3-compatible bucket (Cloudflare R2, AWS S3, MinIO).
// One object per person (people/<id>.json) plus a small index for the people list.
// Assumes one server instance writes (the index is rewritten by this process).
import { AwsClient } from 'aws4fetch';
import { personRow } from '../room.ts';
import type { Person } from './types.ts';

type Row = ReturnType<typeof personRow>;

export class S3Store {
  private s3: AwsClient;
  private base: string;
  private pending = new Map<string, Person>(); // latest unsaved state per person
  private writing?: Promise<void>;
  private index?: Promise<Map<string, Row>>;

  constructor(env: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string }) {
    this.s3 = new AwsClient({ accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey, service: 's3', region: env.region ?? 'auto' });
    this.base = `${env.endpoint.replace(/\/$/, '')}/${env.bucket}`;
  }

  private async get(key: string): Promise<any | undefined> {
    const r = await this.s3.fetch(`${this.base}/${key}`);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`S3 GET ${key}: ${r.status}`);
    return r.json();
  }

  private async put(key: string, body: unknown) {
    const r = await this.s3.fetch(`${this.base}/${key}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(`S3 PUT ${key}: ${r.status}`);
  }

  private rows() {
    this.index ??= this.get('index.json').then((rows: Row[] | undefined) => new Map((rows ?? []).map((r) => [r.id, r])));
    return this.index;
  }

  async load(id: string): Promise<Person | undefined> {
    if (this.pending.has(id)) return structuredClone(this.pending.get(id)) as Person;
    return this.get(`people/${encodeURIComponent(id)}.json`);
  }

  // Saves happen every turn: one writer, always writing each person's latest state.
  save(p: Person) {
    p.updatedAt = Date.now();
    this.pending.set(p.id, structuredClone(p) as Person);
    this.writing ??= this.flush().finally(() => (this.writing = undefined));
  }

  private async flush() {
    const rows = await this.rows();
    while (this.pending.size) {
      const [id, p] = this.pending.entries().next().value!;
      this.pending.delete(id);
      try {
        await this.put(`people/${encodeURIComponent(id)}.json`, p);
        rows.set(id, personRow(p));
        await this.put('index.json', [...rows.values()]);
      } catch (e) {
        console.error('save failed', (e as Error).message);
        if (!this.pending.has(id)) this.pending.set(id, p); // retry on the next save
        return;
      }
    }
  }

  async list() {
    return [...(await this.rows()).values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500);
  }
}
