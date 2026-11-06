// The eval harness. Grade any conversation, simulated or real, and compare two versions of the
// interviewer with paired, per-person confidence intervals. Judge calls are cached on disk
// (eval/results/cache), so re-grading saved conversations is free.
//
//   node eval/run.ts sim     [--people meera,arjun] [--arms ours,baseline] [--turns 12] [--break 6] [--seeds 1] [--label name]
//   node eval/run.ts show    <run.json>                       read one conversation with the interviewer's live gap reads
//   node eval/run.ts grade   <runs...> | --label name | --local | --hosted [ids]   [--out name]
//   node eval/run.ts compare <graded A> <graded B>            paired verdict: primary metric + guards
//   node eval/run.ts meta    [--set graded] [--retest 2]      how far to trust the harness
//   node eval/run.ts improve <graded>                         failure digest → one small prompt edit to A/B
//
// Simulated people have gold facts and gold outsider questions (scenarios/personas.json): the primary
// metric is the gold twin score. Real people have neither: the primary metric is coverage (questions
// their twin's askers would ask, answered from the notes, checked against everything they said).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chat, MODELS } from '../src/brain/llm.ts';
import { PRINCIPLES } from '../src/brain/prompts.ts';
import { cacheStats, JUDGE, spent } from './lib/llm.ts';
import { fromPerson, load, transcript, type Conv } from './lib/conversation.ts';
import { PERSONAS, simulate } from './lib/sim.ts';
import { gradeAll, METRICS } from './lib/score.ts';
import { compare, summarise, type GradedItem, type GradedSet } from './lib/report.ts';
import { coverageValidity, judgeRetest, judgeVsHuman, seedNoise, simRealism } from './lib/meta.ts';

const R = join(import.meta.dirname, 'results');
const RUNS = join(R, 'runs');
const GRADED = join(R, 'graded');
const argv = process.argv.slice(2);
const mode = argv[0];
const arg = (k: string, d = '') => {
  const i = argv.indexOf(`--${k}`);
  return i > 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : i > 0 ? 'true' : d;
};
const files = argv.slice(1).filter((x, i, a) => !x.startsWith('--') && !(a[i - 1]?.startsWith('--')));
const withName = (c: Conv) => (c.persona && c.name === c.persona ? { ...c, name: PERSONAS.find((p) => p.id === c.persona)?.name ?? c.name } : c);
const write = (f: string, x: unknown) => (mkdirSync(join(f, '..'), { recursive: true }), writeFileSync(f, typeof x === 'string' ? x : JSON.stringify(x, null, 1)));
const done = () => console.error(`\ncost this run $${spent().toFixed(3)} · cache ${cacheStats.hits} hits, ${cacheStats.misses} new calls`);

async function hosted(ids: string[]): Promise<Conv[]> {
  const base = process.env.VIVEN_URL ?? 'https://viven-interviewer.utkarshkanwat.com';
  const pass = process.env.VIVEN_PASSCODE ?? execFileSync('security', ['find-generic-password', '-s', 'viven-passcode', '-w']).toString().trim();
  const get = async (p: string) => (await fetch(base + p, { headers: { 'x-passcode': pass } })).json() as Promise<any>;
  if (!ids.length) ids = ((await get('/api/people')).people as any[]).map((p) => p.id);
  const out: Conv[] = [];
  for (const id of ids) {
    const p = await get(`/api/person/${encodeURIComponent(id)}`);
    if (p?.turns?.some((t: any) => t.role === 'person')) out.push(fromPerson(p));
  }
  return out;
}

function localPeople(): Conv[] {
  const dir = join(import.meta.dirname, '../data/people');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => load(join(dir, f))).filter((c) => c.lines.some((l) => l.role === 'person')) : [];
}

async function conversations(): Promise<Conv[]> {
  if (arg('hosted')) return hosted(files);
  if (arg('local')) return localPeople();
  const label = arg('label');
  const fs = label ? readdirSync(RUNS).filter((f) => f.endsWith(`-${label}.json`)).map((f) => join(RUNS, f)) : files;
  return fs.map((f) => withName(load(f)));
}

if (mode === 'sim') {
  const people = PERSONAS.filter((p) => arg('people', PERSONAS.map((x) => x.id).join(',')).split(',').includes(p.id));
  const arms = arg('arms', 'ours').split(',');
  const o = { turns: Number(arg('turns', '12')), breakAt: Number(arg('break', '6')), label: arg('label') || undefined };
  const jobs = people.flatMap((p) => arms.flatMap((arm) => Array.from({ length: Number(arg('seeds', '1')) }, (_, s) => ({ p, arm, seed: 1000 + s }))));
  await Promise.all(
    jobs.map(async ({ p, arm, seed }) => {
      try {
        const r = await simulate(p, arm, { ...o, seed });
        write(join(RUNS, `${r.id}.json`), r);
        const ann = r.lines.filter((l) => l.role === 'person').map((l) => l.annoyance ?? 1);
        console.log(`${r.id.padEnd(28)} ${r.lines.filter((l) => l.role === 'person').length} answers · ${r.notes.length} notes · annoyance max ${Math.max(...ann)}${r.left ? ' · LEFT' : ''}`);
      } catch (e) {
        console.error(`${p.id}/${arm} failed: ${(e as Error).message}`);
      }
    }),
  );
  done();
} else if (mode === 'show') {
  const r = JSON.parse(readFileSync(files[0], 'utf8'));
  const c = withName(load(files[0]));
  let a = 0;
  for (const [i, l] of c.lines.entries()) {
    if (i === 0 || c.lines[i - 1].session !== l.session) console.log(`\n--- session ${l.session} ---`);
    console.log(`${l.role === 'agent' ? 'Q' : `A (${l.annoyance ?? '-'})`}: ${l.text}`);
    if (l.role === 'person' && r.liveGaps?.[a] !== undefined) console.log(`   ↳ live read: ${r.liveGaps[a]}`);
    if (l.role === 'person') a++;
  }
  console.log(`\n--- notes (${c.notes.length}) ---\n${c.notes.join('\n')}`);
  if (r.gaps?.length) console.log(`\n--- gaps file ---\n${r.gaps.map((g: string) => `- ${g}`).join('\n')}`);
} else if (mode === 'grade') {
  const convs = await conversations();
  if (!convs.length) throw new Error('no conversations to grade');
  const items: GradedItem[] = [];
  for (const c of convs) {
    const p = PERSONAS.find((x) => x.id === c.persona);
    const g = await gradeAll(c, p);
    items.push({ id: c.id, name: c.name, source: c.source, persona: c.persona, arm: c.arm, seed: c.seed, metrics: g.metrics, detail: { conversation: g.conversation, notes: g.notes, coverage: g.coverage, facts: g.facts, twin: g.twin } });
    console.error(`graded ${c.id}`);
  }
  const label = arg('out') || arg('label') || (arg('hosted') ? 'hosted' : arg('local') ? 'local' : 'set');
  const set: GradedSet = { label, at: new Date().toISOString(), judge: JUDGE, items };
  write(join(GRADED, `${label}.json`), set);
  const md = summarise(set);
  write(join(GRADED, `${label}.md`), md);
  console.log(md);
  done();
} else if (mode === 'compare') {
  const [a, b] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as GradedSet);
  const r = compare(a, b);
  write(join(GRADED, `compare-${a.label}-vs-${b.label}.md`), r.text);
  console.log(r.text);
} else if (mode === 'meta') {
  const sets = readdirSync(GRADED).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(GRADED, f), 'utf8')) as GradedSet);
  const sims = readdirSync(RUNS).map((f) => withName(load(join(RUNS, f))));
  const real = [...localPeople(), ...(arg('hosted') ? await hosted([]) : [])];
  const parts = ['# How far to trust the harness', `judge ${JUDGE}`, '', await judgeVsHuman()];
  const n = Number(arg('retest', '0'));
  if (n) parts.push(await judgeRetest(sims.slice(0, n)));
  const all: GradedSet = { label: 'all', at: '', judge: JUDGE, items: sets.flatMap((s) => s.items) };
  parts.push(seedNoise(all, Object.keys(METRICS)), simRealism(sims, real), coverageValidity(all));
  const md = parts.join('\n\n');
  write(join(R, 'meta.md'), md);
  console.log(md);
  done();
} else if (mode === 'improve') {
  // The failures, gathered from a graded set, for one small generic edit. Nothing is applied: the
  // edit goes into a branch and through `compare`, and only a win is kept. Prompt optimisers overfit (TextGrad: 91–96% on
  // validation, 62–69% on test; logs/eval-research.md), so propose from one set of people and confirm on others.
  const set = JSON.parse(readFileSync(files[0], 'utf8')) as GradedSet;
  const bad: string[] = [];
  for (const i of set.items) {
    const d = i.detail;
    for (const l of d.conversation?.lines ?? []) {
      const flags = Object.entries(l).filter(([k, v]) => v === true && METRICS[k] && !METRICS[k].up).map(([k]) => k);
      if (flags.length) bad.push(`${i.id} Q${l.q}: ${flags.join(', ')}`);
    }
    for (const a of d.conversation?.answers ?? []) if (a.depth === 'thin' && a.gap) bad.push(`${i.id} A${a.a} thin; a fuller answer would add: ${a.gap}`);
    for (const t of d.twin?.asks ?? []) if (t.grade !== 'right') bad.push(`${i.id} twin ${t.grade}: "${t.q}" truth: ${t.gold}`);
    for (const t of d.coverage?.asks ?? []) if (t.grade === 'invented' || t.grade === 'abstain') bad.push(`${i.id} coverage ${t.grade}: "${t.q}"`);
  }
  const ask = `Below is the interviewer's system prompt, then the failures an eval found across ${set.items.length} conversations.
Propose ONE small, generic edit to the prompt (a sentence added, changed or removed) most likely to fix the most common failure without causing others. No narrow examples that would be parroted, and never name a topic, person or detail from these conversations (the edit must help people we haven't seen); prefer giving the model judgement over rules; shorter is better.
Return: the failure pattern you target (with counts), the exact old text and new text, and what might get worse.

== Prompt ==
${PRINCIPLES}

== Failures ==
${bad.join('\n')}`;
  const md = `# Failure digest: ${set.label}\n\n${bad.map((b) => `- ${b}`).join('\n')}\n\n# Proposed edit\n\n${await chat([{ role: 'user', content: ask }], { model: MODELS.brain, temperature: 0.3, maxTokens: 2000 })}`;
  write(join(GRADED, `improve-${set.label}.md`), md);
  console.log(md);
  done();
} else {
  console.log(readFileSync(import.meta.filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
}
