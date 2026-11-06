// The graders. Each takes a conversation (simulated or real) and returns labels; score.ts turns them
// into numbers. Reference-free graders work on any conversation; the gold graders need a persona's
// hidden facts and outsider questions. The judge is a different model family from the interviewer.
import { askJson, JUDGE, TWIN } from './llm.ts';
import { personText, transcript, type Conv } from './conversation.ts';

export type Persona = {
  id: string;
  name: string;
  behaviour: string;
  who: string;
  style: string;
  facts: { text: string; kind: string; disclosure: 'free' | 'asked' | 'probe' | 'trust'; vital: boolean }[];
  asks?: { q: string; gold: string; facts: number[]; type?: string }[];
};

// ---------- 1. the conversation: every interviewer line and every answer (reference-free) ----------

export type LineLabel = { q: number; open: boolean; reaction: boolean; restates: boolean; multi: boolean; offAudience: boolean; praise: boolean; repeat: boolean; pushes: boolean };
export type AnswerLabel = { a: number; depth: 'thin' | 'some' | 'rich'; gap: string };
export type ConvGrade = { lines: LineLabel[]; answers: AnswerLabel[]; resume: { remembered: boolean | null; reAsked: number } };

// Definitions are shared with the calibration check (meta.ts), so the human labels and the judge use the same words.
export const LINE_DEFS = {
  open: 'leaves room for a long answer (not yes/no, not one fact)',
  reaction: 'opens with a short response that adds something of its own (a thought, a link to earlier, a light remark), not a paraphrase or a compliment',
  restates: 'spends words handing their own answer back to them: a paraphrase, a summary, or a quoted phrase as a statement ("So X was what hid it."). A question that builds on a detail they gave is NOT restating',
  multi: 'asks two or more separate things',
  offAudience: 'asks about something the people who would talk to their twin (colleagues, people wanting their advice, friends) would rarely need',
  praise: 'praises, rates or flatters their answer ("great point", "that\'s a sharp way to put it")',
  repeat: 'asks again for something already asked or already answered',
  pushes: 'presses on after they pushed back, refused or showed annoyance',
};

export async function gradeConversation(c: Conv): Promise<ConvGrade> {
  let a = 0;
  let q = 0;
  const numbered = c.lines
    .map((l, i) => `${i === 0 || c.lines[i - 1].session !== l.session ? `--- session ${l.session} ---\n` : ''}${l.role === 'agent' ? `[Q${++q}] Interviewer` : `[A${++a}] ${c.name}`}: ${l.text}`)
    .join('\n');
  const sessions = new Set(c.lines.map((l) => l.session)).size;
  const j = await askJson<ConvGrade>(
    [
      { role: 'system', content: 'You audit interviews strictly and consistently. Judge each line on its own words in context; when unsure, answer false.' },
      {
        role: 'user',
        content: `An interviewer is talking with ${c.name} so that a digital twin of them can later answer the way they would.

${numbered}

Label EVERY interviewer line [Qn] (true/false each):
${Object.entries(LINE_DEFS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Label EVERY answer [An] by ${c.name}:
- depth: "thin" (generic, vague, a word or a line anyone could say), "some" (their own view or a fact, without the reason or a real example), "rich" (their own view with the reason, a real example, a rule and its exception)
- gap: one short line: the most valuable thing a fuller answer would have added for their twin (their reason, an example, what they'd do instead…), or "" if nothing important is missing
${sessions > 1 ? '\nResume: did the first interviewer line of the later session show it accurately remembers the earlier one? Count later-session questions that re-ask something covered earlier.' : ''}
Return ONLY JSON:
{"lines":[{"q":1,${Object.keys(LINE_DEFS).map((k) => `"${k}":false`).join(',')}}],
 "answers":[{"a":1,"depth":"thin|some|rich","gap":"..."}],
 "resume":{"remembered":${sessions > 1 ? 'true|false' : 'null'},"reAsked":0}}`,
      },
    ],
    { model: JUDGE, temperature: 0, maxTokens: 16000, tag: 'conv-v1' },
  );
  return { lines: j.lines ?? [], answers: j.answers ?? [], resume: j.resume ?? { remembered: null, reAsked: 0 } };
}

// ---------- 2. the notes: faithful to what they said, and complete (reference-free) ----------

export type NotesGrade = { notes: { n: number; support: 'yes' | 'partly' | 'no' }[]; missed: string[] };

export async function gradeNotes(c: Conv): Promise<NotesGrade | null> {
  if (!c.notes.length) return null;
  const j = await askJson<NotesGrade>(
    [
      { role: 'system', content: 'You check notes about a person against what they actually said. Be strict: interviewer guesses and things only the interviewer said do not count as support.' },
      {
        role: 'user',
        content: `What ${c.name} said (their words only):\n${personText(c)}\n\nThe notes kept about them:\n${c.notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}

For each note: is everything in it supported by their words? "yes", "partly" (some of it is invented, over-generalised or a guess), or "no".
Then list what they said that a twin of them would need but no note keeps (their views, reasons, rules, stories, people; not small talk). Short lines; [] if nothing.
Return ONLY JSON: {"notes":[{"n":1,"support":"yes|partly|no"}],"missed":["..."]}`,
      },
    ],
    { model: JUDGE, temperature: 0, maxTokens: 8000, tag: 'notes-v1' },
  );
  return { notes: j.notes ?? [], missed: j.missed ?? [] };
}

// ---------- 3. coverage: can the notes answer what people would ask their twin? (reference-free) ----------
// Questions come from who they are (their first answers), not from the notes, so they aren't biased
// toward what was captured. Answers are graded against the transcript: grounded, invented, or abstained.

export type CoverageGrade = { asks: { q: string; answer: string; grade: 'grounded' | 'partly' | 'invented' | 'abstain' }[] };

export async function coverage(c: Conv, who?: string, n = 8): Promise<CoverageGrade | null> {
  const first = c.lines.filter((l) => l.role === 'person').slice(0, 2).map((l) => l.text).join(' ');
  const about = who ?? first;
  if (!about.trim() || !c.notes.length) return null;
  const gen = await askJson<{ asks: string[] }>(
    [{ role: 'user', content: `Someone has a digital twin that answers for them. All you know about them: "${about.slice(0, 1200)}"\n\nWrite ${n} questions the people most likely to talk to their twin would actually ask it (colleagues, people wanting their advice or expertise, people deciding whether to work with them, friends). Mix advice, opinions, decisions, how they'd handle something, and personal ones. Specific to who they are, not generic.\nReturn ONLY JSON: {"asks":["..."]}` }],
    { model: JUDGE, temperature: 0, maxTokens: 3000, tag: 'cov-gen-v1' },
  );
  const asks = (gen.asks ?? []).slice(0, n);
  const ans = await twinAnswer(c, asks);
  const g = await askJson<{ grades: CoverageGrade['asks'][number]['grade'][] }>(
    [
      { role: 'system', content: 'You check a digital twin\'s answers against everything the real person said. grounded: the substance follows from what they said. partly: some of it does, the rest is filler or a guess. invented: the substance is not in what they said, or contradicts it. abstain: it says it does not know.' },
      { role: 'user', content: `What ${c.name} said:\n${personText(c)}\n\n${asks.map((q, i) => `${i + 1}. Q: ${q}\n   Twin: ${ans[i]}`).join('\n')}\n\nReturn ONLY JSON: {"grades":["grounded|partly|invented|abstain", ...]}` },
    ],
    { model: JUDGE, temperature: 0, maxTokens: 4000, tag: 'cov-grade-v1' },
  );
  return { asks: asks.map((q, i) => ({ q, answer: ans[i], grade: g.grades?.[i] ?? 'invented' })) };
}

// A stand-in twin that knows only the notes (or, with no notes, the transcript).
export async function twinAnswer(c: Conv, questions: string[]): Promise<string[]> {
  const known = c.notes.length ? `Your notes about ${c.name}:\n${c.notes.map((m) => `- ${m}`).join('\n')}` : `Your conversation with ${c.name}:\n${transcript(c, { number: false })}`;
  const a = await askJson<{ answers: string[] }>(
    [
      { role: 'system', content: `You are a digital twin of ${c.name}. You know only what is below. Answer each question the way ${c.name} would, in one or two sentences, first person. If what you know doesn't tell you how they'd answer, say exactly "I don't know." Don't guess from general knowledge.\n\n${known}` },
      { role: 'user', content: `Questions:\n${questions.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nReturn ONLY JSON: {"answers":["<answer to 1>", ...]}` },
    ],
    { model: TWIN, temperature: 0, maxTokens: 4000, tag: 'twin-v1' },
  );
  return questions.map((_, i) => String(a.answers?.[i] ?? "I don't know."));
}

// ---------- 4. gold graders (simulated people only) ----------

export type FactsGrade = { facts: { n: number; said: 'yes' | 'partial' | 'no'; evidence: string; saved: 'yes' | 'partial' | 'no' }[] };

export async function gradeFacts(c: Conv, p: Persona): Promise<FactsGrade> {
  const j = await askJson<FactsGrade>(
    [
      { role: 'system', content: 'You audit interview transcripts strictly. A fact counts as said only if the person clearly said it (partial if only part of it, e.g. the rule but not its reason). Quote the person exactly as evidence.' },
      {
        role: 'user',
        content: `Transcript:\n${transcript(c, { number: false })}\n\nThe interviewer's saved notes:\n${c.notes.map((m) => `- ${m}`).join('\n') || '(none)'}\n\nFacts about ${c.name}:\n${p.facts.map((f, i) => `${i + 1}. ${f.text}`).join('\n')}

For each fact: did ${c.name} say it ("said", with an exact quote), and do the saved notes contain it ("saved")?
Return ONLY JSON: {"facts":[{"n":1,"said":"yes|partial|no","evidence":"<exact quote or empty>","saved":"yes|partial|no"}]}`,
      },
    ],
    { model: JUDGE, temperature: 0, maxTokens: 8000, tag: 'facts-v1' },
  );
  // Evidence must really be in their words, else no credit.
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  const said = norm(personText(c));
  const inWords = (q: string) => q.split(/\.\.\.|…/).map(norm).filter((x) => x.length > 3).every((x) => said.includes(x.slice(0, 40)));
  for (const f of j.facts ?? []) if (f.said !== 'no' && (!f.evidence || !inWords(f.evidence))) f.said = 'no';
  return { facts: j.facts ?? [] };
}

export type TwinGrade = { asks: { q: string; type: string; gold: string; answer: string; grade: 'right' | 'partial' | 'wrong' | 'abstain' }[] };

export async function twinGold(c: Conv, p: Persona): Promise<TwinGrade | null> {
  if (!p.asks?.length) return null;
  const answers = await twinAnswer(c, p.asks.map((x) => x.q));
  const g = await askJson<{ grades: TwinGrade['asks'][number]['grade'][] }>(
    [
      { role: 'system', content: 'You grade a digital twin against the real person. right: the answer matches the substance of the truth, including any key condition or exception. partial: some of it, or the right direction without the reason. wrong: contradicts it or invents a different answer. abstain: says it does not know.' },
      { role: 'user', content: `${p.asks.map((x, i) => `${i + 1}. Q: ${x.q}\n   Truth: ${x.gold}\n   Twin: ${answers[i]}`).join('\n')}\n\nReturn ONLY JSON: {"grades":["right|partial|wrong|abstain", ...]}` },
    ],
    { model: JUDGE, temperature: 0, maxTokens: 4000, tag: 'twin-gold-v1' },
  );
  return { asks: p.asks.map((x, i) => ({ q: x.q, type: x.type ?? 'other', gold: x.gold, answer: answers[i], grade: g.grades?.[i] ?? 'wrong' })) };
}
