import { connectedLabels, renderSources } from './sources.ts';
import { randomUUID } from 'node:crypto';
import { chat, chatJson, chatStream, completedObject, MODELS, type Msg } from './llm.ts';
import {
  PRINCIPLES,
  turnPrompt,
  TURN_FORMAT,
  OPEN_INSTRUCTIONS,
  RESUME_INSTRUCTIONS,
  WRAP_INSTRUCTIONS,
  SUMMARY_PROMPT,
} from './prompts.ts';
import { personId } from './ids.ts';
import { applyNoteOps, notesOf, renderNotes } from './notes.ts';
import type { AnswerLabel, Channel, Decision, Move, NoteOp, Person, Session, Turn } from './types.ts';

// No policy caps in code: when to dig, move on or stop is the model's judgement (see prompts.ts).
const POLICY = { recentTurns: 10 };

const id = () => randomUUID().slice(0, 8);

export function newPerson(name: string, topicHint = ''): Person {
  const now = Date.now();
  return {
    id: personId(name),
    name: name.trim(),
    topicHint: topicHint.trim(),
    createdAt: now,
    updatedAt: now,
    expertise: '',
    language: 'english',
    summary: '',
    turns: [],
    notes: {},
    open: [],
    sessions: [],
    hostility: 0,
    status: 'active',
  };
}

export function startSession(p: Person, channel: Channel, liveSessionId?: string): Session {
  const s: Session = { id: id(), channel, startedAt: Date.now(), liveSessionId };
  p.sessions.push(s);
  p.status = 'active';
  p.hostility = 0;
  return s;
}

export function endSession(p: Person, sessionId: string, reason: string) {
  const s = p.sessions.find((x) => x.id === sessionId);
  if (s && !s.endedAt) {
    s.endedAt = Date.now();
    s.endReason = reason;
  }
  p.status = reason === 'done' ? 'done' : 'paused';
}

// Older records kept typed items; they get notes rebuilt from their transcript on load (room.ts).
export function needsNotes(p: Person) {
  const legacy = !p.notes;
  notesOf(p);
  p.open ??= [];
  return legacy && p.turns.some((t) => t.role === 'person');
}

export function isReturning(p: Person) {
  return p.turns.some((t) => t.role === 'person');
}

// ---------- context the brain sees (compact memory, not the whole transcript) ----------

export function renderContext(p: Person, sessionId?: string): string {
  const lines: string[] = [];
  lines.push(`== Person ==\nName: ${p.name}`);
  if (p.topicHint) lines.push(`Topic they asked for: ${p.topicHint}`);
  if (p.expertise) lines.push(`Who they are: ${p.expertise}`);
  lines.push(`Language they use: ${p.language}`);
  lines.push(`Today: ${new Date().toISOString().slice(0, 10)}, conversation ${p.sessions.length || 1}.`);
  if (p.background?.brief)
    lines.push(`\n== Background from a link they gave (public web, NOT said by them) ==\n${p.background.brief}\nThey shared this link so you'd know a bit about them: use it to ask more specific questions (you can say you had a look). It may be out of date or incomplete, so ask rather than assume, and never put it in the notes: only what they say counts.`);
  const tools = connectedLabels(p);
  lines.push(tools.length ? `Tools they connected: ${tools.join(', ')}.` : 'Tools they connected: none (optional).');
  const src = renderSources(p);
  if (src) lines.push(`\n== Notes from their connected tools (read by an assistant, NOT said by them) ==\n${src}\nThis shows what's in their tools, possibly out of date. Use it to ask about the why and what isn't written down; say where you saw it. Never copy it into their notes: only what they say counts.`);
  if (p.summary) lines.push(`\n== Running summary ==\n${p.summary}`);
  lines.push(`\n== Their notes (what we know; don't re-ask it) ==\n${renderNotes(p)}`);
  if (p.open?.length) lines.push(`\n== Still most worth learning ==\n${p.open.map((x) => `- ${x}`).join('\n')}`);

  const asked = p.turns.filter((t) => t.role === 'agent').map((t) => t.text);
  if (asked.length > POLICY.recentTurns) {
    lines.push('\n== Earlier questions you already asked (never repeat) ==');
    for (const q of asked.slice(0, -POLICY.recentTurns / 2).slice(-25)) lines.push(`- ${q}`);
  }

  const recent = p.turns.slice(-POLICY.recentTurns);
  if (recent.length) {
    lines.push('\n== Recent conversation ==');
    for (const t of recent) {
      const prev = sessionId && t.sessionId !== sessionId ? ' (earlier session)' : '';
      lines.push(`${t.role === 'agent' ? 'Interviewer' : p.name}${prev}: ${t.text}`);
    }
  }
  return lines.join('\n');
}

// ---------- the turn ----------

type TurnOut = {
  read: { label: AnswerLabel; why: string; covered?: string };
  language?: string;
  who?: string | null;
  notes?: NoteOp[];
  open?: string[];
  next: { move: Move; ack?: string; question: string; reason: string };
};

// Facts for this turn, not rules: the model decides what to do with them.
function turnFacts(p: Person, sessionId: string): string {
  const sessTurns = p.turns.filter((x) => x.sessionId === sessionId && x.role === 'person').length;
  return [
    `Their turns this session: ${sessTurns}.`,
    'If they want to stop or talk later: move "wrap". If they asked you something: move "answer", then continue.',
  ].join('\n');
}

// Only shape, never judgement.
function validate(out: TurnOut): string | undefined {
  if (!out.next?.move) return 'Missing next.move.';
  if (out.next.move !== 'wrap' && !out.next.question?.trim()) return 'Missing next.question.';
  return undefined;
}

export async function personTurn(
  p: Person,
  text: string,
  channel: Channel,
  sessionId: string,
  opts: { signal?: AbortSignal; recordAgent?: boolean; onEarly?: (early: { label: AnswerLabel; move: Move; say: string; question: string; reason: string }) => void } = {},
): Promise<Decision> {
  const personTurnRec: Turn = { id: id(), role: 'person', text: text.trim(), channel, sessionId, at: Date.now() };
  p.turns.push(personTurnRec);

  const ctx = renderContext(p, sessionId);
  // Stable first, marked for the prompt cache: principles (shared with opener/resume/wrap and the
  // after-call notes), then the reply format. Only the context after them is new each turn.
  const messages: Msg[] = [
    { role: 'system', content: PRINCIPLES, cache: true },
    { role: 'user', content: [{ text: TURN_FORMAT, cache: true }, { text: turnPrompt(ctx, turnFacts(p, sessionId)) }] },
  ];

  let out: TurnOut | undefined;
  let sentEarly = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let earlySent = false;
    const raw = await chatStream(messages, {
      model: MODELS.brain,
      json: true,
      temperature: 0.5,
      maxTokens: 3000,
      signal: opts.signal,
      // Speak as soon as the move is decided and passes the policy; notes finish after.
      onText: (soFar) => {
        if (earlySent || !opts.onEarly) return;
        const read = completedObject(soFar, 'read');
        const next = read && completedObject(soFar, 'next');
        if (!next) return;
        earlySent = true;
        if (validate({ read, next } as TurnOut)) return;
        sentEarly = true;
        opts.onEarly({ label: read.label, move: next.move, say: [next.ack, next.question].filter((x: string) => x?.trim()).join(' '), question: next.question ?? '', reason: next.reason ?? '' });
      },
    });
    let parsed: TurnOut;
    try {
      parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    } catch {
      messages.push({ role: 'assistant', content: raw }, { role: 'user', content: 'That was not valid JSON. Return only the JSON object.' });
      continue;
    }
    const problem = validate(parsed);
    if (!problem || sentEarly) {
      out = parsed;
      break;
    }
    messages.push({ role: 'assistant', content: raw }, { role: 'user', content: `${problem} Return the complete JSON.` });
  }
  if (!out) throw new Error('Brain returned no usable output');

  personTurnRec.label = out.read.label;
  return applyTurn(p, out, sessionId, channel, opts.recordAgent ?? true);
}

function applyTurn(p: Person, out: TurnOut, sessionId: string, channel: Channel, recordAgent: boolean): Decision {
  const label = out.read.label;
  if (out.language) p.language = out.language;
  if (out.who && out.who !== 'null') p.expertise = out.who;
  if (Array.isArray(out.open)) p.open = out.open.slice(0, 4);

  const lastPersonTurn = [...p.turns].reverse().find((t) => t.role === 'person')!;
  const changes = applyNoteOps(p, out.notes, { turnId: lastPersonTurn.id, sessionId });
  lastPersonTurn.notes = changes.filter((c) => c.op !== 'delete').map((c) => c.path);

  const next = out.next;
  const say = [next.ack, next.question].filter((s) => s && s.trim()).join(' ').trim();
  // In voice the interviewer words its own reply; the transcript records what it actually said.
  if (recordAgent) p.turns.push({ id: id(), role: 'agent', text: say, channel, sessionId, at: Date.now(), move: next.move });

  return { label, move: next.move, say, question: next.question ?? '', reason: next.reason ?? out.read.why ?? '', covered: out.read.covered, changes };
}

// ---------- opener / resume / wrap (agent speaks without a person turn) ----------

type SpeakOut = { next: { move: Move; ack?: string; question: string; reason: string }; say?: string };

export async function opener(p: Person, sessionId: string, channel: Channel, opts: { signal?: AbortSignal } = {}): Promise<Decision> {
  const returning = isReturning(p);
  const instr = returning ? RESUME_INSTRUCTIONS : OPEN_INSTRUCTIONS;
  return speak(p, sessionId, channel, instr, returning ? 'resume' : 'open', opts);
}

export async function wrap(p: Person, sessionId: string, channel: Channel, why: string, opts: { signal?: AbortSignal } = {}): Promise<Decision> {
  return speak(p, sessionId, channel, `${WRAP_INSTRUCTIONS}\nReason for ending: ${why}`, 'wrap', opts);
}

async function speak(p: Person, sessionId: string, channel: Channel, instr: string, move: Move, opts: { signal?: AbortSignal }): Promise<Decision> {
  const ctx = renderContext(p, sessionId);
  const out = await chatJson<SpeakOut>(
    [
      { role: 'system', content: PRINCIPLES, cache: true },
      {
        role: 'user',
        content: `${ctx}\n\n${instr}\nReturn ONLY JSON: {"next": {"move": "${move}", "ack": "<greeting / recap / reflection>", "question": "<the one question, or empty for wrap>", "reason": "<one line: why>"}}`,
      },
    ],
    { model: MODELS.brain, temperature: 0.6, maxTokens: 600, signal: opts.signal },
  );
  const next = out.next;
  const say = [next.ack, next.question].filter((s) => s && s.trim()).join(' ').trim();
  p.turns.push({ id: id(), role: 'agent', text: say, channel, sessionId, at: Date.now(), move });
  return { label: 'rich', move, say, question: next.question ?? '', reason: next.reason ?? '', changes: [] };
}

// ---------- background upkeep ----------

export async function refreshSummary(p: Person, opts: { signal?: AbortSignal } = {}) {
  const ctx = renderContext(p);
  p.summary = (
    await chat(
      [
        { role: 'system', content: 'You keep an interviewer\'s memory notes. Be factual and brief.' },
        { role: 'user', content: `${ctx}\n\n${SUMMARY_PROMPT}` },
      ],
      { model: MODELS.fast, temperature: 0.2, maxTokens: 300, signal: opts.signal },
    )
  ).trim();
}

// Voice: the transcript of what the agent actually said differs from what the brain planned.
// Replace the planned text with the heard transcript so memory reflects reality.
export function recordSpokenAgentText(p: Person, sessionId: string, text: string) {
  const last = [...p.turns].reverse().find((t) => t.sessionId === sessionId);
  if (last && last.role === 'agent') last.text = text.trim();
  else p.turns.push({ id: id(), role: 'agent', text: text.trim(), channel: 'voice', sessionId, at: Date.now() });
}

// ---------- similarity (the report counts repeated questions) ----------

const STOP = new Set('a an the and or but so to of in on at for with you your i me my is are was were be do did does what how why when that this it as about from have has had can could would will just like there their they them we us our'.split(' '));
function tokens(s: string) {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}
export function similarity(a: string, b: string) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) * (Math.min(A.size, B.size) / Math.max(A.size, B.size)) ** 0.25;
}
