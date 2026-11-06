// Eval harness: simulated people with hidden facts talk to an interviewer over the text channel;
// a judge from a different model family checks what was drawn out and what went wrong.
//
//   node eval/run.ts [--arms ours,baseline] [--people meera,arjun] [--turns 12] [--break 6] [--seeds 1] [--label name]
//   node eval/run.ts --compare results/a.json results/b.json
//
// What it measures (cheap judge and twin, different families from the brain):
//   twin      a stand-in twin answers what outsiders would ask the person, from the saved notes only;
//             graded against the truth. The measure that matters: did the interview capture what's needed?
//   recall    which hidden facts the person actually said, and which were saved.
//   feel      per interviewer line: open, a genuine reaction, restating, multi-part, off-audience.
//
// Arms:
//   ours      the product: Room + brain (craft prompts, memory, notes), exactly what the text channel runs.
//   baseline  what you'd build first: the same brain model with one sensible prompt and the chat history.
// Every run has a "call me later" break, then a second session, to test resume.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chat, chatJson, MODELS, usage, type Msg } from '../src/brain/llm.ts';
import { Room, type PersonStore } from '../src/room.ts';
import { personId } from '../src/brain/ids.ts';
import type { Person, Decision } from '../src/brain/types.ts';

type Fact = { text: string; kind: string; disclosure: 'free' | 'asked' | 'probe' | 'trust'; vital: boolean };
type Ask = { q: string; gold: string; facts: number[] };
type Persona = { id: string; name: string; behaviour: string; who: string; style: string; facts: Fact[]; asks?: Ask[] };
type Line = { role: 'agent' | 'person'; text: string; session: number; annoyance?: number };

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const ARMS = arg('arms', 'ours').split(',');
const JUDGE = arg('judge', 'deepseek/deepseek-v4.1-flash');
const TWIN = arg('twin', 'openai/gpt-6-luna');
const LABEL = arg('label', '');
const TURNS = Number(arg('turns', '12'));
const BREAK = Number(arg('break', '6'));
const SEEDS = Number(arg('seeds', '1'));
const ALL: Persona[] = JSON.parse(readFileSync(join(import.meta.dirname, 'scenarios/personas.json'), 'utf8'));
const PEOPLE = ALL.filter((p) => arg('people', ALL.map((x) => x.id).join(',')).split(',').includes(p.id));

// --compare a.json b.json: the same metrics side by side, per person and overall.
if (process.argv.includes('--compare')) {
  const [a, b] = process.argv.slice(process.argv.indexOf('--compare') + 1, process.argv.indexOf('--compare') + 3).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const keys = ['twin', 'twinWrong', 'twinAbstain', 'recall', 'tacitRecall', 'memoryRecall', 'open', 'reaction', 'restates', 'multi', 'offAudience', 'personWords', 'agentWords', 'meanAnnoyance'];
  const row = (ma: any, mb: any) => Object.fromEntries(keys.map((k) => [k, `${ma?.[k]?.toFixed?.(2) ?? '-'} → ${mb?.[k]?.toFixed?.(2) ?? '-'}`]));
  const table: Record<string, any> = {};
  for (const ra of a.results) {
    const rb = b.results.find((x: any) => x.persona === ra.persona && x.arm === ra.arm && x.seed === ra.seed);
    if (rb) table[`${ra.persona}/${ra.arm}`] = row(ra.metrics, rb.metrics);
  }
  const sa = a.summary.find((x: any) => x.arm === 'ours') ?? a.summary[0];
  const sb = b.summary.find((x: any) => x.arm === sa.arm);
  table[`ALL/${sa.arm}`] = row(sa, sb);
  console.log(`${a.label || a.at}  →  ${b.label || b.at}`);
  console.table(table);
  process.exit(0);
}
const CALL_LATER = 'Sorry, I have to go now. Can we continue later?';

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
  const r = await chatJson<{ reply: string; annoyance: number; leave: boolean }>(msgs, { model: MODELS.persona, temperature: 0.8, maxTokens: 500, seed });
  return { reply: String(r.reply ?? '').trim(), annoyance: Number(r.annoyance) || 1, leave: !!r.leave };
}

// ---------- the interviewers ----------

type Interviewer = {
  start(session: number): Promise<{ text: string; wrap?: boolean }>;
  turn(text: string): Promise<{ text: string; wrap: boolean }>;
  end(): Promise<void>;
  memory(): string[];
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
      const b = body(await room.api('text/turn', { id: room.id, sessionId, text }));
      const d = b.decision as Decision;
      return { text: d.say, wrap: d.move === 'wrap' };
    },
    async end() {
      body(await room.api('text/end', { id: room.id, sessionId, reason: 'later' }));
    },
    memory: () => Object.values(mem.get(room.id)?.notes ?? {}).map((n) => `[${n.path}] ${n.title}: ${n.body.replace(/\s+/g, ' ')}`),
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
      const reply = await ask();
      return { text: reply, wrap: text === CALL_LATER };
    },
    async end() {
      earlier += msgs
        .slice(2)
        .map((m) => `${m.role === 'assistant' ? 'Interviewer' : p.name}: ${m.content}`)
        .join('\n');
    },
    memory: () => [],
  };
}

// ---------- one run ----------

async function run(p: Persona, arm: string, seed: number) {
  const iv = arm === 'ours' ? ours(p) : baseline(p);
  const lines: Line[] = [];
  let session = 1;
  let personTurns = 0;
  let left = false;
  let wrappedItself = false;
  let opening = await iv.start(session);
  lines.push({ role: 'agent', text: opening.text, session });
  while (personTurns < TURNS) {
    const breakNow = session === 1 && personTurns === BREAK - 1;
    const sim = breakNow ? { reply: CALL_LATER, annoyance: lines.at(-2)?.annoyance ?? 1, leave: false } : await simReply(p, lines, seed);
    personTurns++;
    lines.push({ role: 'person', text: sim.reply, session, annoyance: sim.annoyance });
    if (sim.leave) {
      left = true;
      break;
    }
    const r = await iv.turn(sim.reply);
    lines.push({ role: 'agent', text: r.text, session });
    if (breakNow) {
      await iv.end();
      session = 2;
      opening = await iv.start(session);
      lines.push({ role: 'agent', text: opening.text, session });
    } else if (r.wrap) {
      wrappedItself = true;
      break;
    }
  }
  if (!left) await iv.end().catch(() => {});
  return { persona: p.id, arm, seed, lines, left, wrappedItself, memory: iv.memory() };
}

// ---------- the judge (different family from the brain and the sim) ----------

type Judged = {
  facts: { n: number; said: 'yes' | 'partial' | 'no'; evidence: string }[];
  memory?: { n: number; saved: 'yes' | 'partial' | 'no' }[];
  issues: { repeated: string[]; praise: string[]; overdrill: string[]; ignored: string[]; pushedAfterPushback: string[] };
  resume: { remembered: boolean; reAsked: string[]; note: string };
  lines?: { q: number; open: boolean; reaction: boolean; restates: boolean; multi: boolean; offAudience: boolean }[];
};

async function judge(p: Persona, r: Awaited<ReturnType<typeof run>>) {
  let q = 0;
  const transcript = r.lines.map((l, i) => `${i === 0 || r.lines[i - 1].session !== l.session ? `--- session ${l.session} ---\n` : ''}${l.role === 'agent' ? `[Q${++q}] Interviewer` : p.name}: ${l.text}`).join('\n');
  const facts = p.facts.map((f, i) => `${i + 1}. ${f.text}`).join('\n');
  const memoryPart = r.memory.length
    ? `\n\nThe interviewer's saved notes:\n${r.memory.map((m) => `- ${m}`).join('\n')}\n\nFor each fact, also say whether the saved notes contain it ("memory").`
    : '';
  const j = await chatJson<Judged>(
    [
      { role: 'system', content: 'You audit interview transcripts strictly. A fact counts as said only if the person clearly said it (partial if only part of it, e.g. the rule but not its reason). Quote the person exactly as evidence.' },
      {
        role: 'user',
        content: `Transcript:\n${transcript}\n\nFacts about ${p.name}:\n${facts}${memoryPart}

Return ONLY JSON:
{"facts":[{"n":1,"said":"yes|partial|no","evidence":"<exact quote from ${p.name}, or empty>"}],
 ${r.memory.length ? '"memory":[{"n":1,"saved":"yes|partial|no"}],' : ''}
 "issues":{"repeated":["<interviewer questions that re-ask something already asked or answered>"],
           "praise":["<interviewer lines that praise or flatter an answer>"],
           "overdrill":["<points pushed 3+ times after the person had already given their view and reason>"],
           "ignored":["<interviewer lines that ignore what the person just said>"],
           "pushedAfterPushback":["<lines that pressed on after the person pushed back or was annoyed>"]},
 "resume":{"remembered":<true if the session-2 opening shows it remembers session 1 accurately>,"reAsked":["<session-2 questions about things already covered in session 1>"],"note":"<one line>"},
 "lines":[{"q":1,"open":<true if it leaves room for a long answer, not yes/no or one fact>,"reaction":<true if it opens with a short genuine response to what they just said>,"restates":<true if it repeats back or summarises what they said>,"multi":<true if it asks two or more things>,"offAudience":<true if it asks about something people who'd talk to their twin (colleagues, people wanting their advice, friends) would rarely need>}]}
Label every [Qn] line in "lines".`,
      },
    ],
    { model: JUDGE, temperature: 0, maxTokens: 5000 },
  );
  // Evidence must really be in the person's words, else no credit.
  const said = r.lines.filter((l) => l.role === 'person').map((l) => l.text.toLowerCase()).join('\n');
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  const saidNorm = norm(said);
  // Quotes joined with "..." are checked piece by piece.
  const inWords = (q: string) => q.split(/\.\.\.|…/).map(norm).filter((x) => x.length > 3).every((x) => saidNorm.includes(x.slice(0, 40)));
  for (const f of j.facts) if (f.said !== 'no' && (!f.evidence || !inWords(f.evidence))) f.said = 'no';
  return { transcript, ...j };
}

// ---------- the twin test: what outsiders would ask, answered from the saved notes only ----------

type TwinAnswer = { q: string; gold: string; answer: string; grade: 'right' | 'partial' | 'wrong' | 'abstain' };

async function twinTest(p: Persona, r: Awaited<ReturnType<typeof run>>, transcript: string): Promise<TwinAnswer[]> {
  if (!p.asks?.length) return [];
  // Ours keeps notes; an arm without notes gets its whole transcript, a generous stand-in.
  const known = r.memory.length ? `Your notes about ${p.name}:\n${r.memory.map((m) => `- ${m}`).join('\n')}` : `Your conversation with ${p.name}:\n${transcript}`;
  const a = await chatJson<{ answers: string[] }>(
    [
      { role: 'system', content: `You are a digital twin of ${p.name}. You know only what is below. Answer each question the way ${p.name} would, in one or two sentences, first person. If what you know doesn't tell you how they'd answer, say exactly "I don't know." Don't guess from general knowledge.\n\n${known}` },
      { role: 'user', content: `Questions:\n${p.asks.map((x, i) => `${i + 1}. ${x.q}`).join('\n')}\n\nReturn ONLY JSON: {"answers":["<answer to 1>", ...]}` },
    ],
    { model: TWIN, temperature: 0, maxTokens: 1500 },
  );
  const answers = p.asks.map((x, i) => ({ q: x.q, gold: x.gold, answer: String(a.answers?.[i] ?? "I don't know.") }));
  const g = await chatJson<{ grades: TwinAnswer['grade'][] }>(
    [
      { role: 'system', content: 'You grade a digital twin against the real person. right: the answer matches the substance of the truth, including any key condition or exception. partial: some of it, or the right direction without the reason. wrong: contradicts it or invents a different answer. abstain: says it does not know.' },
      { role: 'user', content: `${answers.map((x, i) => `${i + 1}. Q: ${x.q}\n   Truth: ${x.gold}\n   Twin: ${x.answer}`).join('\n')}\n\nReturn ONLY JSON: {"grades":["right|partial|wrong|abstain", ...]}` },
    ],
    { model: JUDGE, temperature: 0, maxTokens: 400 },
  );
  return answers.map((x, i) => ({ ...x, grade: g.grades?.[i] ?? 'wrong' }));
}

function score(p: Persona, r: Awaited<ReturnType<typeof run>>, j: Awaited<ReturnType<typeof judge>>, twin: TwinAnswer[]) {
  const val = (s?: string) => (s === 'yes' ? 1 : s === 'partial' ? 0.5 : 0);
  const recall = (pick: (f: Fact) => boolean, get: (i: number) => string | undefined) => {
    let num = 0;
    let den = 0;
    p.facts.forEach((f, i) => {
      if (!pick(f)) return;
      const w = f.vital ? 2 : 1;
      den += w;
      num += w * val(get(i + 1));
    });
    return den ? num / den : 0;
  };
  const said = (n: number) => j.facts.find((f) => f.n === n)?.said;
  const saved = (n: number) => j.memory?.find((f) => f.n === n)?.saved;
  const agent = r.lines.filter((l) => l.role === 'agent');
  const person = r.lines.filter((l) => l.role === 'person');
  const L = j.lines ?? [];
  const rate = (k: keyof NonNullable<Judged['lines']>[number]) => (L.length ? L.filter((x) => x[k]).length / L.length : 0);
  const tg = (g: string) => (twin.length ? twin.filter((t) => t.grade === g).length / twin.length : 0);
  return {
    twin: twin.length ? tg('right') + tg('partial') / 2 : null,
    twinWrong: tg('wrong'),
    twinAbstain: tg('abstain'),
    open: rate('open'),
    reaction: rate('reaction'),
    restates: rate('restates'),
    multi: rate('multi'),
    offAudience: rate('offAudience'),
    personWords: Math.round(person.reduce((s, l) => s + l.text.split(/\s+/).length, 0) / Math.max(1, person.length)),
    recall: recall(() => true, said),
    vitalRecall: recall((f) => f.vital, said),
    tacitRecall: recall((f) => f.disclosure === 'probe' || f.disclosure === 'trust', said),
    memoryRecall: j.memory ? recall(() => true, saved) : null,
    personTurns: person.length,
    left: r.left,
    meanAnnoyance: person.reduce((s, l) => s + (l.annoyance ?? 1), 0) / Math.max(1, person.length),
    maxAnnoyance: Math.max(...person.map((l) => l.annoyance ?? 1)),
    agentWords: Math.round(agent.reduce((s, l) => s + l.text.split(/\s+/).length, 0) / Math.max(1, agent.length)),
    issues: Object.fromEntries(Object.entries(j.issues ?? {}).map(([k, v]) => [k, (v ?? []).length])),
    resumeRemembered: j.resume?.remembered ?? false,
    resumeReAsks: j.resume?.reAsked?.length ?? 0,
  };
}

// ---------- main ----------

const started = Date.now();
const results: any[] = [];
const cost: Record<string, number> = {};
for (const arm of ARMS) {
  const before = usage.costUsd;
  const jobs = PEOPLE.flatMap((p) =>
    Array.from({ length: SEEDS }, (_, s) =>
      (async () => {
        const r = await run(p, arm, 1000 + s);
        const j = await judge(p, r);
        const twin = await twinTest(p, r, j.transcript);
        const m = score(p, r, j, twin);
        console.log(`${arm.padEnd(8)} ${p.id.padEnd(6)} seed ${s}  twin ${m.twin == null ? '-' : (m.twin * 100).toFixed(0) + '%'}  recall ${(m.recall * 100).toFixed(0)}%  tacit ${(m.tacitRecall * 100).toFixed(0)}%  turns ${m.personTurns}  annoy ${m.meanAnnoyance.toFixed(1)}${m.left ? '  LEFT' : ''}`);
        results.push({ persona: p.id, behaviour: p.behaviour, arm, seed: s, metrics: m, facts: p.facts.map((f, i) => ({ ...f, said: j.facts.find((x) => x.n === i + 1)?.said ?? 'no', evidence: j.facts.find((x) => x.n === i + 1)?.evidence ?? '', saved: j.memory?.find((x) => x.n === i + 1)?.saved })), issues: j.issues, resume: j.resume, twin, feel: j.lines, lines: r.lines, memory: r.memory });
      })().catch((e) => console.error(`${arm} ${p.id} failed:`, (e as Error).message)),
    ),
  );
  await Promise.all(jobs);
  cost[arm] = usage.costUsd - before;
}

const fix = (s: Record<string, any>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(2)) : v]));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const summary = ARMS.map((arm) => {
  const rs = results.filter((r) => r.arm === arm).map((r) => r.metrics);
  const issueTotal = (k: string) => rs.reduce((s, m) => s + (m.issues[k] ?? 0), 0);
  return {
    arm,
    runs: rs.length,
    twin: mean(rs.filter((m) => m.twin != null).map((m) => m.twin!)),
    twinWrong: mean(rs.map((m) => m.twinWrong)),
    twinAbstain: mean(rs.map((m) => m.twinAbstain)),
    open: mean(rs.map((m) => m.open)),
    reaction: mean(rs.map((m) => m.reaction)),
    restates: mean(rs.map((m) => m.restates)),
    multi: mean(rs.map((m) => m.multi)),
    offAudience: mean(rs.map((m) => m.offAudience)),
    personWords: mean(rs.map((m) => m.personWords)),
    recall: mean(rs.map((m) => m.recall)),
    vitalRecall: mean(rs.map((m) => m.vitalRecall)),
    tacitRecall: mean(rs.map((m) => m.tacitRecall)),
    memoryRecall: arm === 'ours' ? mean(rs.map((m) => m.memoryRecall ?? 0)) : null,
    meanAnnoyance: mean(rs.map((m) => m.meanAnnoyance)),
    leftEarly: rs.filter((m) => m.left).length,
    agentWords: mean(rs.map((m) => m.agentWords)),
    repeated: issueTotal('repeated'),
    praise: issueTotal('praise'),
    overdrill: issueTotal('overdrill'),
    ignored: issueTotal('ignored'),
    pushedAfterPushback: issueTotal('pushedAfterPushback'),
    resumeRemembered: rs.filter((m) => m.resumeRemembered).length,
    resumeReAsks: rs.reduce((s, m) => s + m.resumeReAsks, 0),
    costUsd: cost[arm],
  };
});
console.table(summary.map((s) => ({ ...s, ...fix(s), recall: s.recall.toFixed(2), vitalRecall: s.vitalRecall.toFixed(2), tacitRecall: s.tacitRecall.toFixed(2), memoryRecall: s.memoryRecall?.toFixed(2), meanAnnoyance: s.meanAnnoyance.toFixed(2), costUsd: s.costUsd.toFixed(3) })));

const out = { at: new Date().toISOString(), minutes: (Date.now() - started) / 60000, label: LABEL, config: { arms: ARMS, people: PEOPLE.map((p) => p.id), turns: TURNS, break: BREAK, seeds: SEEDS, models: { ...MODELS, judge: JUDGE, twin: TWIN } }, summary, results: results.sort((a, b) => a.persona.localeCompare(b.persona) || a.arm.localeCompare(b.arm)) };
const dir = join(import.meta.dirname, 'results');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${out.at.replace(/[:.]/g, '-')}${LABEL ? `-${LABEL}` : ''}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
writeFileSync(join(import.meta.dirname, '../public/eval-results.json'), JSON.stringify(out));
console.log(`wrote ${file} and public/eval-results.json; total cost $${usage.costUsd.toFixed(3)}`);
