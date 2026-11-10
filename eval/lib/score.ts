// From labels to numbers. One Graded record per conversation; metrics are plain fractions so they
// average and compare cleanly. Which metric decides and which only guard is set here, once.
import type { Conv } from './conversation.ts';
import { coverage, gradeConversation, gradeFacts, gradeNotes, twinGold, type ConvGrade, type CoverageGrade, type FactsGrade, type NotesGrade, type Persona, type TwinGrade } from './grade.ts';

export type Graded = { conv: Conv; conversation: ConvGrade; notes: NotesGrade | null; coverage: CoverageGrade | null; facts?: FactsGrade; twin?: TwinGrade | null; metrics: Record<string, number | null> };

// What decides a comparison, and what may not get worse. `up`: higher is better.
export const PRIMARY = { sim: 'twin', real: 'coverage' } as const;
// `count`: a plain number (not a share), shown as such.
export const METRICS: Record<string, { up: boolean; what: string; guard?: boolean; count?: boolean }> = {
  twin: { up: true, what: 'gold outsider questions answered right from the notes (partial = ½)' },
  coverage: { up: true, what: 'generated outsider questions the notes answer with what they really said (partly = ½)' },
  twinAbstain: { up: false, what: 'gold questions the twin had to say "I don\'t know" to' },
  invented: { up: false, what: 'coverage answers the twin made up', guard: true },
  rich: { up: true, what: 'answers that were rich (their view + reason + a real case)' },
  thin: { up: false, what: 'answers that were thin' },
  faithful: { up: true, what: 'notes fully supported by their words', guard: true },
  missed: { up: false, count: true, what: 'things they said that no note keeps, per conversation' },
  recall: { up: true, what: 'hidden facts they said (vital ×2)' },
  saved: { up: true, what: 'hidden facts in the notes (vital ×2)' },
  open: { up: true, what: 'interviewer lines that leave room for a long answer' },
  reaction: { up: true, what: 'lines with a genuine reaction of its own' },
  restates: { up: false, what: 'lines handing their answer back to them', guard: true },
  praise: { up: false, what: 'lines praising their answer', guard: true },
  multi: { up: false, what: 'lines asking two or more things', guard: true },
  repeat: { up: false, what: 'lines re-asking something already covered', guard: true },
  pushes: { up: false, what: 'lines pressing on after pushback', guard: true },
  intro: { up: true, what: 'the opening tells them what this is, what it\'s for, how it goes, that they can ask or stop (partly = ½)' },
  answered: { up: true, what: 'times they asked the interviewer something or objected, and the next line dealt with it first' },
  offAudience: { up: false, what: 'lines asking what their twin\'s askers wouldn\'t need' },
  annoyance: { up: false, count: true, what: 'sim annoyance, 1-5 (sims only)', guard: true },
  left: { up: false, what: 'sim walked out (sims only)', guard: true },
  words: { up: true, count: true, what: 'mean words per answer' },
  areas: { up: true, count: true, what: 'distinct top-level note folders (breadth of their life covered)' },
};

const frac = <T>(xs: T[], f: (x: T) => number) => (xs.length ? xs.reduce((s, x) => s + f(x), 0) / xs.length : null);
const val = (s?: string) => (s === 'yes' ? 1 : s === 'partial' ? 0.5 : 0);

// Of their answers that asked the interviewer something or objected, the share whose next line didn't dodge.
function answered(c: Conv, g: ConvGrade): number | null {
  let a = 0;
  let q = 0;
  const hits: number[] = [];
  let pending = false;
  for (const l of c.lines) {
    if (l.role === 'person') {
      const n = ++a;
      pending = !!g.answers.find((x) => x.a === n)?.asks;
    } else {
      q++;
      if (pending) hits.push(+!g.lines.find((x) => x.q === q)?.dodges);
      pending = false;
    }
  }
  return hits.length ? hits.reduce((s, x) => s + x, 0) / hits.length : null;
}

export async function gradeAll(c: Conv, p?: Persona, who?: string): Promise<Graded> {
  const [conversation, notes, cov, facts, twin] = await Promise.all([gradeConversation(c), gradeNotes(c), coverage(c, who ?? p?.who), p ? gradeFacts(c, p) : undefined, p ? twinGold(c, p) : undefined]);
  const L = conversation.lines;
  const A = conversation.answers;
  const person = c.lines.filter((l) => l.role === 'person');
  const weighted = (get: (f: FactsGrade['facts'][number]) => string) => {
    if (!p || !facts) return null;
    let num = 0;
    let den = 0;
    p.facts.forEach((f, i) => {
      const w = f.vital ? 2 : 1;
      den += w;
      const g = facts.facts.find((x) => x.n === i + 1);
      num += w * (g ? val(get(g)) : 0);
    });
    return den ? num / den : null;
  };
  const metrics: Graded['metrics'] = {
    twin: twin ? frac(twin.asks, (x) => (x.grade === 'right' ? 1 : x.grade === 'partial' ? 0.5 : 0)) : null,
    twinAbstain: twin ? frac(twin.asks, (x) => +(x.grade === 'abstain')) : null,
    coverage: cov ? frac(cov.asks, (x) => (x.grade === 'grounded' ? 1 : x.grade === 'partly' ? 0.5 : 0)) : null,
    invented: cov ? frac(cov.asks, (x) => +(x.grade === 'invented')) : null,
    rich: frac(A, (x) => +(x.depth === 'rich')),
    thin: frac(A, (x) => +(x.depth === 'thin')),
    faithful: notes ? frac(notes.notes, (x) => +(x.support === 'yes')) : null,
    missed: notes ? notes.missed.length : null,
    recall: weighted((g) => g.said),
    saved: weighted((g) => g.saved),
    ...Object.fromEntries((['open', 'reaction', 'restates', 'praise', 'multi', 'repeat', 'pushes', 'offAudience'] as const).map((k) => [k, frac(L, (x) => +!!x[k])])),
    intro: conversation.intro ? { yes: 1, partly: 0.5, no: 0 }[conversation.intro] ?? 0 : null,
    answered: answered(c, conversation),
    annoyance: c.source === 'sim' ? frac(person, (l) => l.annoyance ?? 1) : null,
    left: c.source === 'sim' ? +!!c.left : null,
    words: frac(person, (l) => l.text.split(/\s+/).length),
    areas: c.notes.length ? new Set(c.notes.map((n) => n.match(/^\[([^/\]]+)/)?.[1])).size : null,
  };
  return { conv: c, conversation, notes, coverage: cov, facts, twin, metrics };
}
