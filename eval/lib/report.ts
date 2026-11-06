// Markdown reports: a graded set on its own, and two sets compared with paired verdicts.
import { clusterCI, pairedDiff, type Verdict } from './stats.ts';
import { METRICS, PRIMARY } from './score.ts';

export type GradedItem = { id: string; name: string; source: 'sim' | 'real'; persona?: string; arm?: string; seed?: number; metrics: Record<string, number | null>; detail: any };
export type GradedSet = { label: string; at: string; judge: string; items: GradedItem[] };

const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : Math.abs(x) <= 1.5 ? `${(x * 100).toFixed(0)}%` : x.toFixed(1));
const cluster = (i: GradedItem) => i.persona ?? i.id;

export function summarise(set: GradedSet) {
  const out: string[] = [`# ${set.label}`, `${set.items.length} conversations · judge ${set.judge} · ${set.at.slice(0, 16)}`, '', '| metric | mean | 95% CI (by person) | worst person | what |', '|---|---|---|---|---|'];
  for (const [k, m] of Object.entries(METRICS)) {
    const by = new Map<string, number[]>();
    for (const i of set.items) if (i.metrics[k] != null) by.set(cluster(i), [...(by.get(cluster(i)) ?? []), i.metrics[k]!]);
    if (!by.size) continue;
    const ci = clusterCI([...by.values()]);
    // Worst case matters as much as the mean: one person badly served is a failure the average hides.
    const per = [...by.values()].map((v) => v.reduce((s, x) => s + x, 0) / v.length);
    out.push(`| ${k}${m.guard ? ' (guard)' : ''} | ${pct(ci.mean)} | ${pct(ci.lo)} – ${pct(ci.hi)} | ${pct(m.up ? Math.min(...per) : Math.max(...per))} | ${m.what} |`);
  }
  out.push('', '## Per conversation', '', `| conversation | ${Object.keys(METRICS).join(' | ')} |`, `|---|${Object.keys(METRICS).map(() => '---').join('|')}|`);
  for (const i of set.items) out.push(`| ${i.id} | ${Object.keys(METRICS).map((k) => pct(i.metrics[k])).join(' | ')} |`);
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
  const prim = rows.find((r) => r.k === primary)?.d.verdict ?? "can't tell";
  const hurt = rows.filter((r) => METRICS[r.k].guard && r.d.verdict === 'worse').map((r) => r.k);
  const overall: Verdict | 'mixed' = hurt.length ? (prim === 'better' ? 'mixed' : 'worse') : prim;
  const out = [
    `# ${b.label} vs ${a.label}`,
    `${pairs.length} paired conversations, ${new Set(pairs.map((p) => cluster(p.x))).size} people. Primary: **${primary}**. Guards may not get worse.`,
    '',
    `**Verdict: ${overall}**${hurt.length ? ` (worse on ${hurt.join(', ')})` : ''}`,
    '',
    '| metric | A | B | B−A | 95% CI | verdict |',
    '|---|---|---|---|---|---|',
  ];
  const meanOf = (s: GradedSet, k: string) => {
    const xs = s.items.map((i) => i.metrics[k]).filter((v): v is number => v != null);
    return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null;
  };
  for (const { k, d } of rows) out.push(`| ${k === primary ? `**${k}**` : k}${METRICS[k].guard ? ' (guard)' : ''} | ${pct(meanOf(a, k))} | ${pct(meanOf(b, k))} | ${pct(d.mean)} | ${pct(d.lo)} – ${pct(d.hi)} | ${d.verdict} |`);
  out.push('', 'With a few people per side, "can\'t tell" is the honest default: see `meta` for the smallest difference this setup can detect.');
  return { overall, primary: prim, hurt, text: out.join('\n') };
}
