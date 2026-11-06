// Markdown reports: a graded set on its own, and two sets compared with paired verdicts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clusterCI, pairedDiff, passK, type Verdict } from './stats.ts';
import { METRICS, PRIMARY } from './score.ts';
import { unfair, type Spec } from './spec.ts';

export type GradedItem = { id: string; name: string; source: 'sim' | 'real'; persona?: string; arm?: string; seed?: number; metrics: Record<string, number | null>; detail: any; conv?: any; runSpec?: Spec };
// errors: conversations that failed to grade. They are left out, never scored as zero.
export type GradedSet = { label: string; at: string; judge: string; items: GradedItem[]; spec?: Spec; answeredBy?: Record<string, number>; errors?: { id: string; error: string }[] };

const show = (x: number | null | undefined, k?: string) => (x == null || !Number.isFinite(x) ? '–' : k && METRICS[k]?.count ? x.toFixed(1) : `${(x * 100).toFixed(0)}%`);
const cluster = (i: GradedItem) => i.persona ?? i.id;

// dev / held-out people (eval/scenarios/splits.json). `improve` reads only dev; compare reports
// held-out on its own line. (Here, not in score.ts, so the judge hash doesn't move.)
export const SPLITS: { dev: string[]; heldout: string[] } = JSON.parse(readFileSync(join(import.meta.dirname, '../scenarios/splits.json'), 'utf8'));
export const heldOut = (i: GradedItem) => !!i.persona && SPLITS.heldout.includes(i.persona);

// A sim conversation "passes" for pass^k when nothing went wrong for the person: they stayed, never
// got past mildly annoyed (peak under 3 of 5), and the twin invented nothing. Quality is the primary
// metric's job; this is the floor every try must clear.
export const passed = (i: GradedItem) => !i.metrics.left && Math.max(1, ...((i.conv?.lines ?? []) as { annoyance?: number }[]).map((l) => l.annoyance ?? 1)) < 3 && !i.metrics.invented;

// pass^1..k over sims with several seeds per person and arm.
function reliability(items: GradedItem[]) {
  const by = new Map<string, boolean[]>();
  for (const i of items) if (i.source === 'sim') by.set(`${i.persona}|${i.arm}`, [...(by.get(`${i.persona}|${i.arm}`) ?? []), passed(i)]);
  const tries = [...by.values()].map((v) => ({ n: v.length, c: v.filter(Boolean).length }));
  const most = Math.max(0, ...tries.map((t) => t.n));
  if (!tries.length) return [];
  const ks = [1, 2, 4, 8].filter((k) => k <= most);
  return ['', `**Reliability:** ${ks.map((k) => `pass^${k} ${show(passK(tries, k))}`).join(' · ')}${most < 2 ? ' (one seed per person: run --seeds 4 to see pass^k)' : ''}. Pass = stayed, peak annoyance under 3, nothing invented; pass^k = all k tries with the same person pass.`];
}

export function summarise(set: GradedSet) {
  const fell = Object.entries(set.answeredBy ?? {}).filter(([m]) => m !== set.judge);
  const out: string[] = [
    `# ${set.label}`,
    `${set.items.length} conversations · judge ${set.judge} · ${set.at.slice(0, 16)}${set.spec ? ` · commit ${set.spec.commit}${set.spec.dirty ? '+' : ''} · judge prompts ${set.spec.judge}` : ''}`,
    ...(fell.length ? [`⚠ Some judge calls fell back to another model: ${fell.map(([m, n]) => `${m} ×${n}`).join(', ')}.`] : []),
    ...(set.errors?.length ? [`⚠ ${set.errors.length} failed to grade and are left out: ${set.errors.map((e) => e.id).join(', ')}.`] : []),
    ...reliability(set.items),
    '', '| metric | mean | 95% CI (by person) | worst person | what |', '|---|---|---|---|---|'];
  for (const [k, m] of Object.entries(METRICS)) {
    const by = new Map<string, number[]>();
    for (const i of set.items) if (i.metrics[k] != null) by.set(cluster(i), [...(by.get(cluster(i)) ?? []), i.metrics[k]!]);
    if (!by.size) continue;
    const ci = clusterCI([...by.values()]);
    // Worst case matters as much as the mean: one person badly served is a failure the average hides.
    const per = [...by.values()].map((v) => v.reduce((s, x) => s + x, 0) / v.length);
    out.push(`| ${k}${m.guard ? ' (guard)' : ''} | ${show(ci.mean, k)} | ${show(ci.lo, k)} – ${show(ci.hi, k)} | ${show(m.up ? Math.min(...per) : Math.max(...per), k)} | ${m.what} |`);
  }
  out.push('', '## Per conversation', '', `| conversation | ${Object.keys(METRICS).join(' | ')} |`, `|---|${Object.keys(METRICS).map(() => '---').join('|')}|`);
  for (const i of set.items) out.push(`| ${i.id} | ${Object.keys(METRICS).map((k) => show(i.metrics[k], k)).join(' | ')} |`);
  return out.join('\n');
}

// B against A. Pairs are the same person (and seed, for sims); resampled by person.
export function compare(a: GradedSet, b: GradedSet) {
  const key = (i: GradedItem) => (i.source === 'sim' ? `${i.persona}#${i.seed}` : i.id);
  const pairs = a.items.flatMap((x) => {
    const y = b.items.find((z) => key(z) === key(x));
    return y ? [{ x, y }] : [];
  });
  const source = pairs[0]?.x.source ?? 'sim';
  const primary = PRIMARY[source];
  const rows: { k: string; d: ReturnType<typeof pairedDiff> }[] = [];
  for (const [k, m] of Object.entries(METRICS)) {
    const ps = pairs.filter((p) => p.x.metrics[k] != null && p.y.metrics[k] != null).map((p) => ({ cluster: cluster(p.x), a: p.x.metrics[k]!, b: p.y.metrics[k]! }));
    if (ps.length) rows.push({ k, d: pairedDiff(ps, m.up) });
  }
  // Only a fair comparison: same judge, sim, personas and models, so the interviewer is the one thing that differs.
  // Run specs are checked pair by pair (same person on both sides), judge excepted: the set spec covers it.
  const why = [...new Set([...unfair(a.spec, b.spec), ...pairs.flatMap((p) => unfair(p.x.runSpec, p.y.runSpec).filter((x) => !x.startsWith('judge')).map((x) => (x.includes('no spec') ? 'some runs have no spec (made before specs were recorded)' : x)))])];
  const prim = rows.find((r) => r.k === primary)?.d.verdict ?? "can't tell";
  // The primary on held-out people alone: an edit proposed from dev people should win here too.
  const ho = pairs.filter((p) => heldOut(p.x) && p.x.metrics[primary] != null && p.y.metrics[primary] != null);
  const hoD = ho.length ? pairedDiff(ho.map((p) => ({ cluster: cluster(p.x), a: p.x.metrics[primary]!, b: p.y.metrics[primary]! })), METRICS[primary].up) : null;
  const hurt = rows.filter((r) => METRICS[r.k].guard && r.d.verdict === 'worse').map((r) => r.k);
  const overall: Verdict | 'mixed' = hurt.length ? (prim === 'better' ? 'mixed' : 'worse') : prim;
  const out = [
    `# ${b.label} vs ${a.label}`,
    `${pairs.length} paired conversations, ${new Set(pairs.map((p) => cluster(p.x))).size} people. Primary: **${primary}**. Guards may not get worse.`,
    '',
    `**Verdict: ${overall}**${hurt.length ? ` (worse on ${hurt.join(', ')})` : ''}`,
    ...(hoD ? [`Held-out people only (${SPLITS.heldout.join(', ')}): ${primary} B−A ${show(hoD.mean, primary)} (${show(hoD.lo, primary)} – ${show(hoD.hi, primary)}), ${hoD.verdict}.`] : []),
    ...(why.length ? ['', `⚠ Not a clean comparison: ${why.join('; ')}.`] : []),
    '',
    '| metric | A | B | B−A | 95% CI | verdict |',
    '|---|---|---|---|---|---|',
  ];
  const meanOf = (s: GradedSet, k: string) => {
    const xs = s.items.map((i) => i.metrics[k]).filter((v): v is number => v != null);
    return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null;
  };
  for (const { k, d } of rows) out.push(`| ${k === primary ? `**${k}**` : k}${METRICS[k].guard ? ' (guard)' : ''} | ${show(meanOf(a, k), k)} | ${show(meanOf(b, k), k)} | ${show(d.mean, k)} | ${show(d.lo, k)} – ${show(d.hi, k)} | ${d.verdict} |`);
  out.push('', 'With a few people per side, "can\'t tell" is the honest default: see `meta` for the smallest difference this setup can detect.');
  return { overall, primary: prim, hurt, text: out.join('\n') };
}
