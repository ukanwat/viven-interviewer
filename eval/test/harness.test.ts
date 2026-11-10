// Tests of the harness itself: no model calls, so free to run on every change (`npm run test:eval`).
// A harness that miscounts gives confident wrong answers, which is worse than none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kappa, pairedDiff, passK } from '../lib/stats.ts';
import { unfair, spec } from '../lib/spec.ts';
import { compare, heldOut, passed, SPLITS, summarise, type GradedItem, type GradedSet } from '../lib/report.ts';
import { viewHtml } from '../lib/view.ts';
import { fromRun } from '../lib/conversation.ts';
import type { Persona } from '../lib/grade.ts';

const PERSONAS: Persona[] = JSON.parse(readFileSync(join(import.meta.dirname, '../scenarios/personas.json'), 'utf8'));

test('pass^k: C(c,k)/C(n,k), averaged over people', () => {
  const tries = [{ n: 4, c: 4 }, { n: 4, c: 2 }, { n: 4, c: 0 }];
  assert.equal(passK(tries, 1), 0.5);
  assert.ok(Math.abs(passK(tries, 2) - (1 + 1 / 6) / 3) < 1e-9);
  assert.equal(passK([{ n: 4, c: 3 }], 4), 0);
});

test('paired verdict respects which way is better', () => {
  const up = Array.from({ length: 8 }, (_, i) => ({ cluster: `p${i}`, a: 0.2, b: 0.6 + i * 0.01 }));
  assert.equal(pairedDiff(up, true).verdict, 'better');
  assert.equal(pairedDiff(up, false).verdict, 'worse');
  const flat = up.map((p, i) => ({ ...p, b: i % 2 ? 0.1 : 0.3 }));
  assert.equal(pairedDiff(flat, true).verdict, "can't tell");
});

test('kappa: perfect agreement is 1', () => {
  assert.equal(kappa([true, false, true, false], [true, false, true, false]).kappa, 1);
});

test('unfair: only the interviewer and brain model may differ', () => {
  const a = spec({ brain: 'x', judge: 'j' }, [PERSONAS[0]]);
  assert.deepEqual(unfair(a, { ...a, interviewer: 'other', models: { ...a.models, brain: 'y' } }), []);
  assert.match(unfair(a, { ...a, judge: 'zzz' })[0], /judge differs/);
  assert.match(unfair(a, { ...a, models: { ...a.models, judge: 'k' } })[0], /judge model differs/);
  assert.ok(unfair(a, undefined).length);
  // A persona's hash covers that persona only: adding people to the file doesn't move it.
  assert.equal(spec({}, [PERSONAS[0]]).personas, a.personas);
  assert.notEqual(spec({}, [PERSONAS[1]]).personas, a.personas);
});

test('personas are well formed and every one is in exactly one split', () => {
  const ids = PERSONAS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate persona id');
  for (const p of PERSONAS) {
    assert.ok(p.facts.length >= 8, `${p.id}: few facts`);
    assert.ok(p.facts.some((f) => f.vital), `${p.id}: no vital fact`);
    for (const f of p.facts) assert.ok(['free', 'asked', 'probe', 'trust'].includes(f.disclosure), `${p.id}: bad disclosure`);
    assert.ok(p.facts.some((f) => f.disclosure === 'trust') && p.facts.some((f) => f.disclosure === 'probe'), `${p.id}: needs probe and trust facts`);
    for (const a of p.asks ?? []) for (const n of a.facts) assert.ok(n >= 1 && n <= p.facts.length, `${p.id}: ask "${a.q}" points at fact ${n}`);
    const inDev = SPLITS.dev.includes(p.id);
    assert.notEqual(inDev, SPLITS.heldout.includes(p.id), `${p.id}: must be in exactly one split`);
  }
  for (const id of [...SPLITS.dev, ...SPLITS.heldout]) assert.ok(ids.includes(id), `split names unknown persona ${id}`);
});

// ---------- reports on made-up sets ----------

const item = (persona: string, seed: number, m: Record<string, number | null>, annoy = 1): GradedItem => ({
  id: `${persona}-ours-${seed}`, name: persona, source: 'sim', persona, arm: 'ours', seed,
  metrics: { twin: 0.3, restates: 0.2, left: 0, invented: 0, ...m },
  detail: {}, conv: { lines: [{ role: 'person', text: 'hi', session: 1, annoyance: annoy }] },
});
const set = (label: string, items: GradedItem[]): GradedSet => ({ label, at: '2026-11-07T00:00', judge: 'j', items });
const people = [...SPLITS.dev, ...SPLITS.heldout];

test('compare: better primary with no guard worse is "better"; a worse guard makes it mixed', () => {
  const A = set('A', people.map((p) => item(p, 1, { twin: 0.2 })));
  const B = set('B', people.map((p, i) => item(p, 1, { twin: 0.5 + i * 0.01 })));
  assert.equal(compare(A, B).overall, 'better');
  const Bbad = set('B', people.map((p, i) => item(p, 1, { twin: 0.5 + i * 0.01, restates: 0.6 + i * 0.01 })));
  const r = compare(A, Bbad);
  assert.equal(r.overall, 'mixed');
  assert.deepEqual(r.hurt, ['restates']);
  assert.match(r.text, /Held-out people only/);
});

test('pass: leaving, peak annoyance 3+, or invention fails a try', () => {
  assert.ok(passed(item('meera', 1, {})));
  assert.ok(!passed(item('meera', 1, { left: 1 })));
  assert.ok(!passed(item('meera', 1, {}, 3)));
  assert.ok(!passed(item('meera', 1, { invented: 0.1 })));
});

test('summary shows pass^k when there are several seeds', () => {
  const s = set('S', people.flatMap((p) => [1, 2].map((seed) => item(p, seed, {}, p === 'sam' && seed === 2 ? 4 : 1))));
  const md = summarise(s);
  assert.match(md, /pass\^1 95%/);
  assert.match(md, /pass\^2 91%/);
});

test('held-out filter', () => {
  assert.ok(heldOut(item(SPLITS.heldout[0], 1, {})));
  assert.ok(!heldOut(item(SPLITS.dev[0], 1, {})));
});

test('viewer escapes conversation text so it cannot break out of the page', () => {
  const it = item('meera', 1, {});
  it.conv = { lines: [{ role: 'person', text: '</script><img src=x onerror=alert(1)>', session: 1 }], notes: [] };
  const html = viewHtml(set('V', [it]));
  assert.equal(html.match(/<\/script>/g)?.length, 1);
});

test('fromRun fills id, name and notes for older runs', () => {
  const c = fromRun({ persona: 'meera', arm: 'ours', seed: 1, lines: [], memory: ['[a] b: c'] });
  assert.equal(c.id, 'meera-ours-1');
  assert.equal(c.name, 'meera');
  assert.deepEqual(c.notes, ['[a] b: c']);
});

test('triage counts #tags on failed reviews, newest review wins', async () => {
  const { triage, tagsOf } = await import('../lib/triage.ts');
  assert.deepEqual(tagsOf('asked twice #Repeat and #missed-story #repeat'), ['repeat', 'missed-story']);
  const md = triage([
    { id: 'a', set: 's', pass: false, note: '#restates echoed her', at: '1' },
    { id: 'b', set: 's', pass: false, note: '#restates again', at: '1' },
    { id: 'c', set: 's', pass: false, note: 'no tag here', at: '1' },
    { id: 'c', set: 's', pass: true, note: '', at: '2' },
    { id: 'd', set: 's', pass: false, note: 'untagged', at: '1' },
  ]);
  assert.match(md, /4 conversations reviewed, 3 failed/);
  assert.match(md, /\| restates \| 2 \| 67% \|/);
  assert.match(md, /Failures still to tag \(1\)/);
});
