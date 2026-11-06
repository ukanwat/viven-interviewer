// The "after the call" view: what was captured, where it's thin, what to ask next time.
// Numbers come from code; the judgement (gaps, next questions, golden match) from a judge model
// of a different family than the brain.
import { chatJson, MODELS } from './llm.ts';
import { notesOf, renderNotes } from './notes.ts';
import type { Person } from './types.ts';

export type Report = {
  stats: {
    personTurns: number;
    agentTurns: number;
    notes: number; // all notes about them
    notesTouched: number; // notes added or changed this session
    labels: Record<string, number>;
    moves: Record<string, number>;
    newPerTurn: number[]; // notes changed per answer: the saturation curve
    avgAnswerWords: number;
    repeatedQuestions: number;
  };
  judge: {
    headline: string;
    strongest: string[];
    gaps: { thread: string; missing: string }[];
    nextQuestions: string[];
    interviewerIssues: string[];
    notesIssues?: string[];
  };
  golden?: { fact: string; captured: 'yes' | 'partial' | 'no'; evidence: string }[];
  goldenRecall?: number;
};

export async function sessionReport(p: Person, sessionId?: string): Promise<Report> {
  const turns = sessionId ? p.turns.filter((t) => t.sessionId === sessionId) : p.turns;
  const notes = Object.values(notesOf(p));
  const touched = sessionId ? notes.filter((n) => n.sessions.includes(sessionId)) : notes;
  const personTurns = turns.filter((t) => t.role === 'person');
  const agentTurns = turns.filter((t) => t.role === 'agent');

  const count = (xs: (string | undefined)[]) => xs.reduce<Record<string, number>>((m, x) => (x ? ((m[x] = (m[x] ?? 0) + 1), m) : m), {});
  const newPerTurn = personTurns.map((t) => t.notes?.length ?? 0);
  let repeated = 0;
  const { similarity } = await import('./brain.ts');
  agentTurns.forEach((t, i) => {
    if (agentTurns.slice(0, i).some((u) => similarity(u.text, t.text) > 0.62)) repeated++;
  });

  const stats: Report['stats'] = {
    personTurns: personTurns.length,
    agentTurns: agentTurns.length,
    notes: notes.length,
    notesTouched: touched.length,
    labels: count(personTurns.map((t) => t.label)),
    moves: count(agentTurns.map((t) => t.move)),
    newPerTurn,
    avgAnswerWords: personTurns.length ? Math.round(personTurns.reduce((s, t) => s + t.text.split(/\s+/).length, 0) / personTurns.length) : 0,
    repeatedQuestions: repeated,
  };

  const transcript = turns.map((t) => `${t.role === 'agent' ? 'Interviewer' : p.name}: ${t.text}`).join('\n');
  const captured = renderNotes(p);

  const judge = await chatJson<Report['judge']>(
    [
      {
        role: 'system',
        content:
          'You review conversations whose goal is to learn a person well enough that a digital twin could answer, decide and react like them: their stories, choices and why, values and beliefs, rules of thumb and exceptions, how they react and talk. Anything a generic model would guess about them has no value. Be specific and terse. Refer to the person by name or "they".',
      },
      {
        role: 'user',
        content: `Transcript:\n${transcript}\n\nThe interviewer's notes about them:\n${captured}\n\nReturn ONLY JSON:
{"headline": "<one sentence: how much of what makes this person themselves was captured>",
 "notesIssues": ["<notes that say something their words don't support, are about the conversation rather than them, or carry the interviewer's framing; empty if none>"],
 "strongest": ["<up to 3 most valuable captured pieces, short>"],
 "gaps": [{"thread": "<topic>", "missing": "<what is still missing: e.g. a decision without its why, an outcome, the exception>"}],
 "nextQuestions": ["<up to 4 questions for next time, spoken style, each targeting a gap>"],
 "interviewerIssues": ["<concrete mistakes by the interviewer: repeated question, missed a probe on a vague answer, pushed after hostility, off-topic; empty if none>"]}
Gaps list SLOTS that are missing, never invented content.`,
      },
    ],
    { model: MODELS.judge, temperature: 0.2, maxTokens: 1500 },
  );

  const report: Report = { stats, judge };

  if (p.sealedGolden?.length) {
    const g = await chatJson<{ facts: { fact: string; captured: 'yes' | 'partial' | 'no'; evidence: string }[] }>(
      [
        { role: 'system', content: 'You check whether specific facts were stated by the person in an interview transcript. Be strict: "yes" only if the person clearly said it; "partial" if part of it; quote their words as evidence.' },
        {
          role: 'user',
          content: `Transcript:\n${transcript}\n\nFacts:\n${p.sealedGolden.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nReturn ONLY JSON: {"facts":[{"fact":"...","captured":"yes|partial|no","evidence":"<exact quote from ${p.name}, or empty>"}]}`,
        },
      ],
      { model: MODELS.judge, temperature: 0, maxTokens: 1500 },
    );
    // Evidence must actually appear in the transcript, else no credit.
    const lower = transcript.toLowerCase();
    report.golden = g.facts.map((f) => (f.captured !== 'no' && f.evidence && !lower.includes(f.evidence.toLowerCase().slice(0, 40)) ? { ...f, captured: 'no' as const } : f));
    report.goldenRecall = report.golden.reduce((s, f) => s + (f.captured === 'yes' ? 1 : f.captured === 'partial' ? 0.5 : 0), 0) / report.golden.length;
  }
  return report;
}
