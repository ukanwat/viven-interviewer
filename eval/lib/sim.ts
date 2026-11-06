// Simulated people with hidden facts, and the interviewers they talk to. A run is two sessions with a
// "call me later" break in between, so resume is always tested. The product arm drives the real Room
// over the text channel, exactly as the site does; the baseline is what you'd build first.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chat, MODELS, type Msg } from '../../src/brain/llm.ts';
import { Room, type PersonStore } from '../../src/room.ts';
import { personId } from '../../src/brain/ids.ts';
import type { Person, Decision } from '../../src/brain/types.ts';
import { askJson, SIM } from './llm.ts';
import type { Persona } from './grade.ts';
import type { Conv, Line } from './conversation.ts';

export const PERSONAS: Persona[] = JSON.parse(readFileSync(join(import.meta.dirname, '../scenarios/personas.json'), 'utf8'));
export const CALL_LATER = 'Sorry, I have to go now. Can we continue later?';

// ---------- the simulated person ----------

const RELEASE = {
  free: 'you may bring this up yourself when it fits',
  asked: 'share only if they ask about this area of your life',
  probe: 'share only if they ask for a specific instance, your reason, a comparison or exactly what you notice or do; a general question gets a general answer',
  trust: 'share only once they have shown they really listened (built on something you said, or reflected it back accurately) and it feels safe',
};

function simSystem(p: Persona) {
  return `You are role-playing ${p.who}
Someone is interviewing you by chat. Stay fully in character. Never mention being an AI or a simulation.

How you talk: ${p.style}

What you know about yourself, and when you'd share each piece (never list them, never volunteer more than one or two per answer, and don't recite them word for word):
${p.facts.map((f) => `- ${f.text} [${RELEASE[f.disclosure]}]`).join('\n')}

You may add small realistic colour, but don't invent important new facts about yourself and never contradict the ones above.
Like a real person, you get annoyed by: repeated questions, questions you already answered, generic "tell me more", being praised for answers, long or multi-part questions, being pushed after you pushed back, and the interviewer ignoring what you just said. You warm up when they are specific, curious and build on what you said. If your annoyance reaches 5, end the conversation in character.

Reply ONLY with JSON: {"reply": "<what you say>", "annoyance": <1-5, how annoyed you are now>, "leave": <true if you end the conversation now>}`;
}

async function simReply(p: Persona, lines: Line[], seed: number) {
  // From the sim's side, the interviewer is the "user" and it is the "assistant".
  const msgs: Msg[] = [{ role: 'system', content: simSystem(p) }];
  for (const l of lines) msgs.push({ role: l.role === 'agent' ? 'user' : 'assistant', content: l.role === 'agent' ? l.text : JSON.stringify({ reply: l.text, annoyance: l.annoyance ?? 1, leave: false }) });
  const r = await askJson<{ reply: string; annoyance: number; leave: boolean }>(msgs, { model: SIM, temperature: 0.8, maxTokens: 2000, seed, tag: 'sim-v1' });
  return { reply: String(r.reply ?? '').trim(), annoyance: Number(r.annoyance) || 1, leave: !!r.leave };
}

// ---------- the interviewers ----------

type Interviewer = {
  start(session: number): Promise<{ text: string }>;
  turn(text: string): Promise<{ text: string; wrap: boolean; gap?: string }>;
  end(): Promise<void>;
  person(): Person | undefined;
};

function ours(p: Persona): Interviewer {
  const mem = new Map<string, Person>();
  const store: PersonStore = { load: async (id) => mem.get(id), save: (x) => void mem.set(x.id, x) };
  const room = new Room(personId(p.name), store, async () => {
    throw new Error('no voice in eval');
  });
  let sessionId = '';
  const body = (r: { status: number; body: any }) => {
    if (r.status !== 200) throw new Error(`room ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return {
    async start() {
      const b = body(await room.api('text/start', { name: p.name }));
      sessionId = b.sessionId;
      return { text: (b.decision as Decision).say };
    },
    async turn(text) {
      const d = body(await room.api('text/turn', { id: room.id, sessionId, text })).decision as Decision;
      return { text: d.say, wrap: d.move === 'wrap', gap: d.gap };
    },
    async end() {
      body(await room.api('text/end', { id: room.id, sessionId, reason: 'later' }));
    },
    person: () => mem.get(room.id),
  };
}

const BASELINE = (name: string) =>
  `You are a warm, curious interviewer talking with ${name}. Your goal is to get to know them well enough that a digital twin of them could answer, decide and react the way they would. Ask one short question at a time, conversationally. Cover the different sides of their life: work, values, relationships, how they make decisions. If they want to stop, wrap up kindly.`;

function baseline(p: Persona): Interviewer {
  let msgs: Msg[] = [];
  let earlier = '';
  const ask = async () => {
    const text = (await chat(msgs, { model: MODELS.brain, temperature: 0.5, maxTokens: 700 })).trim();
    msgs.push({ role: 'assistant', content: text });
    return text;
  };
  return {
    async start(session) {
      // A second session gets the whole earlier transcript: a generous stand-in for memory.
      const sys = BASELINE(p.name) + (earlier ? `\n\nYou talked before; here is that conversation:\n${earlier}\nThey are back now. Continue.` : '');
      msgs = [{ role: 'system', content: sys }, { role: 'user', content: session === 1 ? `(${p.name} has joined. Start.)` : `(${p.name} is back. Start.)` }];
      return { text: await ask() };
    },
    async turn(text) {
      msgs.push({ role: 'user', content: text });
      return { text: await ask(), wrap: text === CALL_LATER };
    },
    async end() {
      earlier += msgs.slice(2).map((m) => `${m.role === 'assistant' ? 'Interviewer' : p.name}: ${m.content}`).join('\n');
    },
    person: () => undefined,
  };
}

// ---------- one run ----------

export type RunOpts = { turns: number; breakAt: number; seed: number; label?: string };

// A saved run: the conversation plus what the product kept (notes, gaps file, its live read of each answer).
export type Run = Conv & { label?: string; gaps?: string[]; liveGaps?: (string | undefined)[]; wrappedItself: boolean; at: string };

export async function simulate(p: Persona, arm: string, o: RunOpts): Promise<Run> {
  const iv = arm === 'baseline' ? baseline(p) : ours(p);
  const lines: Line[] = [];
  const liveGaps: (string | undefined)[] = [];
  let session = 1;
  let personTurns = 0;
  let left = false;
  let wrappedItself = false;
  lines.push({ role: 'agent', text: (await iv.start(session)).text, session });
  while (personTurns < o.turns) {
    const breakNow = session === 1 && personTurns === o.breakAt - 1;
    const sim = breakNow ? { reply: CALL_LATER, annoyance: lines.at(-2)?.annoyance ?? 1, leave: false } : await simReply(p, lines, o.seed);
    personTurns++;
    lines.push({ role: 'person', text: sim.reply, session, annoyance: sim.annoyance });
    if (sim.leave) {
      left = true;
      break;
    }
    const r = await iv.turn(sim.reply);
    liveGaps.push(r.gap);
    lines.push({ role: 'agent', text: r.text, session });
    if (breakNow) {
      await iv.end();
      session = 2;
      lines.push({ role: 'agent', text: (await iv.start(session)).text, session });
    } else if (r.wrap) {
      wrappedItself = true;
      break;
    }
  }
  if (!left) await iv.end().catch(() => {});
  const kept = iv.person();
  const notes = Object.values(kept?.notes ?? {}).map((n) => `[${n.path}] ${n.title}: ${n.body.replace(/\s+/g, ' ')}`);
  return { id: `${p.id}-${arm}-${o.seed}${o.label ? `-${o.label}` : ''}`, name: p.name, source: 'sim', lines, notes, persona: p.id, arm, seed: o.seed, left, wrappedItself, label: o.label, gaps: kept?.open, liveGaps, at: new Date().toISOString() };
}
