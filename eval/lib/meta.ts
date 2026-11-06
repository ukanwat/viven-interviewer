// How far to trust the harness itself. Each check says what it measures and what a good value is.
//   judge vs human   my hand labels on interviewer lines (eval/calibration/lines.json) vs the judge: kappa
//   judge retest     the same conversation graded again with the cache off: how often a label flips
//   seed noise       the same person, arm and prompt on two seeds: the spread, and the smallest change
//                    this many people can detect (MDE). A prompt change smaller than the MDE is invisible.
//   sim realism      how simulated answers compare with real people's (length, questions back, depth)
//   coverage valid   does the reference-free coverage score track the gold twin score on sims?
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, type Conv } from './conversation.ts';
import { gradeConversation, LINE_DEFS } from './grade.ts';
import { corr, kappa, mean, minDetectable, sd } from './stats.ts';
import type { GradedSet } from './report.ts';

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '–');

export async function judgeVsHuman() {
  const file = join(import.meta.dirname, '../calibration/lines.json');
  if (!existsSync(file)) return '- judge vs human: no hand labels yet (eval/calibration/lines.json)';
  const cal: { file: string; labels: Record<string, Record<keyof typeof LINE_DEFS, boolean>> }[] = JSON.parse(readFileSync(file, 'utf8'));
  const human: Record<string, boolean[]> = {};
  const judge: Record<string, boolean[]> = {};
  for (const c of cal) {
    const g = await gradeConversation(load(join(import.meta.dirname, '..', c.file)));
    for (const [q, lab] of Object.entries(c.labels)) {
      const j = g.lines.find((l) => l.q === Number(q));
      if (!j) continue;
      for (const k of Object.keys(LINE_DEFS) as (keyof typeof LINE_DEFS)[]) {
        if (lab[k] === undefined) continue;
        (human[k] ??= []).push(lab[k]);
        (judge[k] ??= []).push(!!j[k]);
      }
    }
  }
  const rows = Object.keys(human).map((k) => {
    const r = kappa(human[k], judge[k]);
    const yes = human[k].filter(Boolean).length;
    return `| ${k} | ${r.n} | ${yes} | ${f2(r.agree)} | ${f2(r.kappa)} |`;
  });
  return ['### Judge vs my hand labels', 'kappa: above 0.6 trust it, 0.4–0.6 use with care, below 0.4 don\'t steer by it. With few "yes" cases kappa is unstable; read agreement too.', '', '| label | lines | human yes | agree | kappa |', '|---|---|---|---|---|', ...rows].join('\n');
}

export async function judgeRetest(convs: Conv[]) {
  const flips: Record<string, [number, number]> = {};
  for (const c of convs) {
    const a = await gradeConversation(c);
    process.env.NO_CACHE = '1';
    const b = await gradeConversation(c).finally(() => delete process.env.NO_CACHE);
    for (const la of a.lines) {
      const lb = b.lines.find((x) => x.q === la.q);
      if (!lb) continue;
      for (const k of Object.keys(LINE_DEFS) as (keyof typeof LINE_DEFS)[]) {
        const f = (flips[k] ??= [0, 0]);
        f[1]++;
        if (!!la[k] !== !!lb[k]) f[0]++;
      }
    }
  }
  return ['### Judge retest (same input, cache off)', 'Share of labels that flip: under 5% is steady; a metric whose flip rate is near its effect size can\'t be steered by.', '', ...Object.entries(flips).map(([k, [x, n]]) => `- ${k}: ${x}/${n} flipped (${((x / n) * 100).toFixed(0)}%)`)].join('\n');
}

// Needs a graded set with at least two seeds per person and arm.
export function seedNoise(set: GradedSet, metrics: string[]) {
  const out = ['### Seed noise and the smallest detectable change', 'Same person and prompt, two seeds. MDE = smallest true change a comparison over this many people would catch 80% of the time.', '', '| metric | pairs | sd of seed difference | MDE, 5 people | MDE, 20 people |', '|---|---|---|---|---|'];
  for (const k of metrics) {
    const by = new Map<string, number[]>();
    for (const i of set.items) if (i.metrics[k] != null) by.set(`${i.persona}|${i.arm}`, [...(by.get(`${i.persona}|${i.arm}`) ?? []), i.metrics[k]!]);
    const diffs = [...by.values()].filter((v) => v.length >= 2).map((v) => v[1] - v[0]);
    if (diffs.length < 2) continue;
    // A difference of two seeds has twice the variance of one run; a paired A/B difference has the same.
    const s = sd(diffs);
    out.push(`| ${k} | ${diffs.length} | ${f2(s)} | ${f2(minDetectable(s, 5))} | ${f2(minDetectable(s, 20))} |`);
  }
  return out.join('\n');
}

export function simRealism(sims: Conv[], real: Conv[]) {
  const stats = (cs: Conv[]) => {
    const ans = cs.flatMap((c) => c.lines.filter((l) => l.role === 'person' && !/continue later/i.test(l.text)).map((l) => l.text));
    const w = ans.map((t) => t.split(/\s+/).length);
    return { n: ans.length, words: mean(w), long: ans.length ? w.filter((x) => x >= 60).length / ans.length : NaN, short: ans.length ? w.filter((x) => x <= 8).length / ans.length : NaN, asksBack: ans.length ? ans.filter((t) => t.includes('?')).length / ans.length : NaN };
  };
  const s = stats(sims);
  const r = stats(real);
  return [
    '### Simulated vs real people',
    'If sims answer very differently from real people, wins on sims may not carry over.',
    '',
    '| | answers | mean words | ≥60 words | ≤8 words | asks back |',
    '|---|---|---|---|---|---|',
    `| sims | ${s.n} | ${f2(s.words)} | ${f2(s.long)} | ${f2(s.short)} | ${f2(s.asksBack)} |`,
    `| real | ${r.n} | ${f2(r.words)} | ${f2(r.long)} | ${f2(r.short)} | ${f2(r.asksBack)} |`,
  ].join('\n');
}

export function coverageValidity(set: GradedSet) {
  const xs = set.items.filter((i) => i.metrics.coverage != null && i.metrics.twin != null);
  if (xs.length < 4) return '### Coverage vs gold twin\nNot enough graded sims with both scores yet.';
  const r = corr(xs.map((i) => i.metrics.coverage!), xs.map((i) => i.metrics.twin!));
  return `### Coverage vs gold twin\nPearson r = ${f2(r)} over ${xs.length} sims. Above ~0.5, the reference-free coverage score is a fair stand-in for the gold one on real conversations; near 0, it measures something else.`;
}
