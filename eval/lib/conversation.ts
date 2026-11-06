// One shape for every conversation the harness grades: a simulated run, a saved person record from
// the local server, or a live one fetched from the hosted site. Graders only ever see this.
import { readFileSync } from 'node:fs';
import type { Person } from '../../src/brain/types.ts';

export type Line = { role: 'agent' | 'person'; text: string; session: number; annoyance?: number };
export type Conv = {
  id: string; // unique per conversation (person-arm-seed for sims, person id for real ones)
  name: string;
  source: 'sim' | 'real';
  lines: Line[];
  notes: string[]; // the saved notes, one string per note ("[path] title: body"), as the twin would read them
  persona?: string; // sims: which persona
  arm?: string;
  seed?: number;
  left?: boolean;
};

// A saved person record (local data/people/*.json, or GET /api/person/:id on the hosted site).
export function fromPerson(p: Person): Conv {
  const sessions = [...new Set(p.turns.map((t) => t.sessionId))];
  const lines = p.turns.filter((t) => t.text?.trim()).map((t) => ({ role: t.role as Line['role'], text: t.text, session: sessions.indexOf(t.sessionId) + 1 }));
  const notes = Object.values(p.notes ?? {}).map((n) => `[${n.path}] ${n.title}: ${n.body.replace(/\s+/g, ' ')}`);
  return { id: p.id, name: p.name, source: 'real', lines, notes };
}

// A saved simulated run (eval/results/runs/*.json).
export function fromRun(r: any): Conv {
  return { ...r, id: r.id ?? `${r.persona}-${r.arm}-${r.seed}`, name: r.name ?? r.persona, source: 'sim', notes: r.notes ?? r.memory ?? [] };
}

export function load(file: string): Conv {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return j.turns ? fromPerson(j.person ?? j) : j.person?.turns ? fromPerson(j.person) : fromRun(j);
}

// Transcript with numbered interviewer lines ([Q1]…) so graders can label each one.
export function transcript(c: Conv, opts: { number?: boolean } = {}) {
  let q = 0;
  return c.lines
    .map((l, i) => `${i === 0 || c.lines[i - 1].session !== l.session ? `--- session ${l.session} ---\n` : ''}${l.role === 'agent' ? `${opts.number === false ? '' : `[Q${++q}] `}Interviewer` : c.name}: ${l.text}`)
    .join('\n');
}

export const personText = (c: Conv) => c.lines.filter((l) => l.role === 'person').map((l) => l.text).join('\n');
