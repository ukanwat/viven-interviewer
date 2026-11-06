import { randomUUID } from 'node:crypto';
import { chat, chatJson, chatStream, completedObject, MODELS, type Msg } from './llm.ts';
import {
  PRINCIPLES,
  turnPrompt,
  OPEN_INSTRUCTIONS,
  RESUME_INSTRUCTIONS,
  WRAP_INSTRUCTIONS,
  SUMMARY_PROMPT,
} from './prompts.ts';
import { personId } from './ids.ts';
import type {
  Angle,
  AnswerLabel,
  Channel,
  Decision,
  Item,
  ItemKind,
  Move,
  Person,
  Session,
  Thread,
  Turn,
} from './types.ts';

// No policy caps in code: when to dig, move on or stop is the model's judgement (see prompts.ts).
const POLICY = { recentTurns: 10, maxItemsInContext: 60 };

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
    items: [],
    threads: [],
    sessions: [],
    hostility: 0,
    status: 'active',
  };
}

export function activeThread(p: Person): Thread | undefined {
  return p.threads.find((t) => t.id === p.activeThreadId);
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

export function isReturning(p: Person) {
  return p.turns.some((t) => t.role === 'person');
}

// ---------- context the brain sees (compact memory, not the whole transcript) ----------

export function renderContext(p: Person, sessionId?: string): string {
  const lines: string[] = [];
  lines.push(`== Person ==\nName: ${p.name}`);
  if (p.topicHint) lines.push(`Topic they asked for: ${p.topicHint}`);
  if (p.expertise) lines.push(`Where their expertise seems to be: ${p.expertise}`);
  lines.push(`Language they use: ${p.language}`);
  if (p.summary) lines.push(`\n== Running summary ==\n${p.summary}`);

  if (p.threads.length) {
    lines.push('\n== Threads ==');
    for (const t of p.threads) {
      const active = t.id === p.activeThreadId ? ' [ACTIVE]' : '';
      lines.push(
        `- ${t.id} "${t.title}" status=${t.status}${active} turns=${t.turns} weak_in_a_row=${t.weakStreak} angles_tried=${t.anglesTried.join(',') || '-'}` +
          (t.gaps.length ? `\n  gaps: ${t.gaps.join('; ')}` : ''),
      );
    }
  }

  const items = p.items.slice(-POLICY.maxItemsInContext);
  if (items.length) {
    lines.push(`\n== What we've captured (${p.items.length} items; don't re-ask these) ==`);
    for (const i of items) {
      lines.push(`- [${i.kind}${i.novelty === 'textbook' ? ', textbook' : ''}] ${i.text}${i.why ? ` (why: ${i.why})` : ''}`);
    }
  }

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
  read: { label: AnswerLabel; why: string };
  language?: string;
  expertise?: string | null;
  items?: { kind: ItemKind; text: string; why?: string | null; novelty: 'new' | 'textbook'; evidence: string; thread?: string }[];
  thread?: { id?: string; title?: string; gaps?: string[] };
  next: { move: Move; angle?: Angle | 'null' | null; target?: string; ack?: string; question: string; reason: string };
};

// Facts for this turn, not rules: the model decides what to do with them.
function turnFacts(p: Person, sessionId: string): string {
  const t = activeThread(p);
  const sessTurns = p.turns.filter((x) => x.sessionId === sessionId && x.role === 'person').length;
  return [
    t ? `Current thread: "${t.title}" (${t.id}), ${t.turns} turn(s) so far.` : 'No thread yet.',
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
  const personTurnRec: Turn = { id: id(), role: 'person', text: text.trim(), channel, sessionId, at: Date.now(), threadId: p.activeThreadId };
  p.turns.push(personTurnRec);

  const ctx = renderContext(p, sessionId);
  const sys: Msg = { role: 'system', content: PRINCIPLES };
  const messages: Msg[] = [sys, { role: 'user', content: turnPrompt(ctx, turnFacts(p, sessionId)) }];

  let out: TurnOut | undefined;
  let sentEarly = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let earlySent = false;
    const raw = await chatStream(messages, {
      model: MODELS.brain,
      json: true,
      temperature: 0.5,
      maxTokens: 1400,
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
  if (out.expertise && out.expertise !== 'null') p.expertise = out.expertise;

  // Thread the answer belonged to.
  let t = p.threads.find((x) => x.id === out.thread?.id) ?? activeThread(p);
  if (!t || out.thread?.id === 'new') {
    if (out.thread?.title || !t) {
      t = makeThread(p, out.thread?.title || p.topicHint || 'Getting to know their expertise');
      p.activeThreadId = t.id;
    }
  }
  const lastPersonTurn = p.turns[p.turns.length - 1];
  lastPersonTurn.threadId = t.id;

  // New knowledge items (deduped against memory).
  const newItems: Item[] = [];
  for (const raw of out.items ?? []) {
    if (!raw?.text) continue;
    if (isDuplicateItem(p, raw.text)) continue;
    const item: Item = {
      id: id(),
      kind: raw.kind ?? 'context',
      text: raw.text,
      why: raw.why || undefined,
      novelty: raw.novelty === 'textbook' ? 'textbook' : 'new',
      evidence: raw.evidence ?? '',
      threadId: p.threads.some((x) => x.id === raw.thread) ? raw.thread : t.id,
      turnId: lastPersonTurn.id,
      sessionId,
      at: Date.now(),
    };
    p.items.push(item);
    newItems.push(item);
  }

  // Thread bookkeeping, for the panel and the report.
  t.turns++;
  if (out.thread?.gaps) t.gaps = out.thread.gaps.slice(0, 5);
  if (newItems.some((i) => i.novelty === 'new')) t.emptyTurns = 0;
  else t.emptyTurns++;

  // Apply the move.
  const next = out.next;
  const angle = next.angle && next.angle !== 'null' ? (next.angle as Angle) : undefined;
  if (next.move === 'switch' || next.move === 'redirect') {
    t.status = ['vague', 'short', 'idk', 'hostile', 'bored'].includes(label) ? 'parked' : 'done';
    const target = next.target ?? '';
    const existing = p.threads.find((x) => x.id === target && x.id !== t!.id);
    const nt = existing ?? makeThread(p, target.replace(/^new:\s*/i, '') || 'New thread');
    nt.status = 'active';
    p.activeThreadId = nt.id;
  } else if (next.move === 'wrap') {
    t.status = t.status === 'active' ? 'open' : t.status;
  }

  const say = [next.ack, next.question].filter((s) => s && s.trim()).join(' ').trim();
  // In voice the interviewer words its own reply; the transcript records what it actually said.
  if (recordAgent) p.turns.push({ id: id(), role: 'agent', text: say, channel, sessionId, at: Date.now(), move: next.move, threadId: p.activeThreadId });

  return {
    label,
    move: next.move,
    angle,
    threadId: p.activeThreadId,
    say,
    question: next.question ?? '',
    reason: next.reason ?? out.read.why ?? '',
    newItems,
  };
}

function makeThread(p: Person, title: string): Thread {
  const t: Thread = { id: `t${p.threads.length + 1}`, title: title.slice(0, 80), status: 'active', weakStreak: 0, anglesTried: [], turns: 0, emptyTurns: 0, gaps: [], createdAt: Date.now() };
  for (const x of p.threads) if (x.status === 'active') x.status = 'open';
  p.threads.push(t);
  return t;
}

// ---------- opener / resume / wrap (agent speaks without a person turn) ----------

type SpeakOut = { next: { move: Move; ack?: string; question: string; reason: string; target?: string }; say?: string };

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
      { role: 'system', content: PRINCIPLES },
      {
        role: 'user',
        content: `${ctx}\n\n${instr}\nReturn ONLY JSON: {"next": {"move": "${move}", "ack": "<greeting / recap / reflection>", "question": "<the one question, or empty for wrap>", "reason": "<one line: why>", "target": "<thread id to continue, or 'new: <title>'>"}}`,
      },
    ],
    { model: MODELS.brain, temperature: 0.6, maxTokens: 600, signal: opts.signal },
  );
  const next = out.next;
  if (move === 'open' && !p.activeThreadId) {
    const t = makeThread(p, p.topicHint || 'Getting to know them');
    p.activeThreadId = t.id;
  }
  if (move === 'resume' && next.target) {
    const existing = p.threads.find((x) => x.id === next.target);
    if (existing) {
      for (const x of p.threads) if (x.status === 'active') x.status = 'open';
      existing.status = 'active';
      p.activeThreadId = existing.id;
    }
  }
  const say = [next.ack, next.question].filter((s) => s && s.trim()).join(' ').trim();
  p.turns.push({ id: id(), role: 'agent', text: say, channel, sessionId, at: Date.now(), move, threadId: p.activeThreadId });
  return { label: 'rich', move, say, question: next.question ?? '', reason: next.reason ?? '', newItems: [], threadId: p.activeThreadId };
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
  else p.turns.push({ id: id(), role: 'agent', text: text.trim(), channel: 'voice', sessionId, at: Date.now(), threadId: p.activeThreadId });
}

// ---------- similarity helpers (repetition + dedupe) ----------

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
function isDuplicateItem(p: Person, text: string) {
  return p.items.some((i) => similarity(i.text, text) > 0.8);
}
