// GPT-Live is the mouth. The brain (OpenRouter) decides what to ask; this file wires the two.
//
// Flow per call:
//   browser --SDP offer--> server --POST /v1/live/sessions (client delegation)--> OpenAI
//   server attaches a sideband WebSocket to the same session:
//     transcript deltas  -> segment into turns -> brain.personTurn() -> UI panel
//     delegation.created -> answer with session.commentary.append(next question)
//   audio flows browser <-> OpenAI directly over WebRTC.

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import * as brain from '../brain/brain.ts';
import type { Decision, Person } from '../brain/types.ts';
import type { Store } from '../brain/store.ts';

const API = 'https://api.openai.com/v1';
export const VOICE_MODEL = process.env.VOICE_MODEL ?? 'gpt-live-1';
export const VOICE = process.env.VOICE ?? 'marin';

// How long the person must be silent (no new input transcript) before we treat their turn as finished.
const END_OF_TURN_MS = Number(process.env.END_OF_TURN_MS ?? 1100);

export function voiceInstructions(p: Person) {
  return `You are the voice of a curious interviewer talking with ${p.name}. Your job is to learn what ${p.name} knows from experience that isn't in any textbook, so it can be kept. You are an apprentice, they are the expert.

Personality: warm, unhurried, genuinely curious, a little informal. Short sentences. Never gushing, never praise like "great answer". You sound like someone who is really listening.

Language: speak the language ${p.name} speaks. If they speak Hindi or mix Hindi and English (Hinglish), answer in the same natural mix. Start in English unless they start otherwise.

Backchannel policy: Use moderate, quiet backchannels ("mm", "haan", "right") while they talk, especially during stories. Never talk over a story.

Interruption policy: When ${p.name} interrupts, stop speaking right away and listen. Respond to what they said.

Patience: People pause to think while explaining things they've never put into words. Keep listening through pauses of a few seconds. Do not jump in early.

How the questions work: an interview planner chooses every question. You do not make up the next question yourself.

Delegation policy:
Backend tools:
- Interview planner: reads what ${p.name} just said, keeps the notes, and decides the next question.

Generate <|SpawnThinking|> when:
- ${p.name} has finished an answer or a story and it's your turn to ask something.
- ${p.name} pushes back, is annoyed, asks why you're asking, or asks to stop or talk later.
- ${p.name} asks you a question about the interview.

Do not generate <|SpawnThinking|> when:
- ${p.name} is still in the middle of speaking or just paused to think.
- You only need to say a short backchannel.

After you generate <|SpawnThinking|>, you may say a very short, natural acknowledgement that reflects their words (a few words, not praise, not a question), then wait for the planner. When the planner's text arrives, say it naturally in your own voice and in their language, keeping its meaning. Ask only that one question, then stop and listen.

If ${p.name} says to stop or to call later, acknowledge warmly and let the planner close.`;
}

function historyInput(p: Person, opening: Decision) {
  const input: any[] = [];
  const brief = [
    `Context for this call (from the interviewer's notes, not said by the user):`,
    p.summary && `Summary so far: ${p.summary}`,
    p.expertise && `Their expertise: ${p.expertise}`,
    p.items.length ? `Things they already taught (do not re-ask): ${p.items.slice(-15).map((i) => i.text).join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (p.items.length || p.summary) input.push(msg('developer', brief));
  // Seed the last few real turns so the voice model has the thread (Live accepts history only at start).
  const prior = p.turns.slice(0, -1).slice(-10); // last turn is the opener we're about to say
  for (const t of prior) input.push(t.role === 'agent' ? msg('assistant', t.text) : msg('user', t.text));
  input.push(msg('developer', `Speak first now. Say this opening naturally, keeping its meaning, then stop and listen: "${opening.say}"`));
  return input;
}

function msg(role: 'user' | 'assistant' | 'developer', text: string) {
  return { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] };
}

type Notify = (event: Record<string, unknown>) => void;

export type CallHandle = {
  hangup(reason: string): Promise<void>;
  typed(text: string): void;
};

// One live call. Owns the sideband, the turn segmentation and the brain queue.
export async function startCall(opts: {
  store: Store;
  person: Person;
  offerSdp: string;
  notify: Notify;
}): Promise<{ answerSdp: string; handle: CallHandle; sessionId: string }> {
  const { store, notify } = opts;
  const p = opts.person;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');

  const session = brain.startSession(p, 'voice');
  // Brain prepares the opening line (greeting, or recap if they're returning).
  const opening = await brain.opener(p, session.id, 'voice');
  store.save(p);
  notify({ type: 'brain', decision: opening, person: publicPerson(p) });

  const res = await fetch(`${API}/live/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: {
        model: VOICE_MODEL,
        instructions: voiceInstructions(p),
        input: historyInput(p, opening),
        audio: { output: { voice: VOICE } },
        delegation: { type: 'client', acknowledgement_delay_ms: 600 },
      },
      transport: { type: 'webrtc', sdp: opts.offerSdp },
    }),
  });
  if (!res.ok) {
    const reqId = res.headers.get('x-request-id');
    let detail = '';
    try {
      const j: any = await res.json();
      detail = j?.error?.code ?? j?.error?.type ?? '';
    } catch {}
    throw new Error(`Live session creation failed (HTTP ${res.status}${detail ? `, ${detail}` : ''})${reqId ? `, request ${reqId}` : ''}`);
  }
  const created: any = await res.json();
  const liveId: string = created.session.id;
  session.liveSessionId = liveId;
  store.save(p);

  const ws = new WebSocket(`${API.replace('https', 'wss')}/live/sessions/${encodeURIComponent(liveId)}/attach`, {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: 15_000,
  });

  const send = (event: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event_id: randomUUID(), ...event }));
  };

  // ---- turn segmentation ----
  let userBuf = '';
  let agentBuf = '';
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let brainQueue: Promise<void> = Promise.resolve();
  let latest: { decision: Pick<Decision, 'move' | 'say'>; delivered: boolean } | undefined;
  const pendingDelegations: string[] = [];
  let closing = false;
  let greeted = false;
  let wrapTimer: ReturnType<typeof setTimeout> | undefined;

  const flushAgent = () => {
    const text = agentBuf.trim();
    agentBuf = '';
    // Ignore pure backchannels when recording what the agent said.
    if (text.split(/\s+/).length >= 4) {
      brain.recordSpokenAgentText(p, session.id, text);
      store.save(p);
    }
  };

  const finishUserTurn = () => {
    clearTimeout(endTimer);
    const text = userBuf.trim();
    userBuf = '';
    if (!text || closing) return;
    flushAgent();
    notify({ type: 'turn_end', role: 'person', text });
    const run = async () => {
      notify({ type: 'thinking', on: true });
      const t0 = Date.now();
      try {
        let early = false;
        const d = await brain.personTurn(p, text, 'voice', session.id, {
          onEarly: (e) => {
            early = true;
            latest = { decision: { move: e.move, say: e.say }, delivered: false };
            notify({ type: 'early', move: e.move, say: e.say, ms: Date.now() - t0 });
            deliver();
          },
        });
        store.save(p);
        if (!early) latest = { decision: d, delivered: false };
        notify({ type: 'brain', decision: d, ms: Date.now() - t0, person: publicPerson(p) });
        deliver();
        if (d.move === 'wrap') scheduleWrapClose();
        maybeSummarise();
      } catch (e) {
        console.error('brain error', (e as Error).message);
        notify({ type: 'error', message: 'The planner had a hiccup; the conversation continues.' });
      } finally {
        notify({ type: 'thinking', on: false });
      }
    };
    brainQueue = brainQueue.then(run, run);
  };

  // Send the brain's latest decision to the voice model. Prefer answering a delegation (spoken);
  // otherwise leave it as quiet context so the next spawn uses it.
  const deliver = () => {
    if (!latest || latest.delivered) return;
    const d = latest.decision;
    const content = spokenGuidance(d, p);
    const delegationId = pendingDelegations.shift();
    if (delegationId) {
      send({ type: 'session.commentary.append', delegation_id: delegationId, content });
      latest.delivered = true;
      notify({ type: 'delivered', via: 'delegation' });
    } else {
      send({
        type: 'session.thinking.append',
        delegation_id: null,
        content: `Planner's next step, to use at the next pause: ${content}`,
      });
      notify({ type: 'delivered', via: 'thinking' });
    }
  };

  const scheduleWrapClose = () => {
    clearTimeout(wrapTimer);
    // Let the goodbye play, then close the call.
    wrapTimer = setTimeout(() => void handle.hangup('later'), 20_000);
  };

  let turnsSinceSummary = 0;
  const maybeSummarise = () => {
    if (++turnsSinceSummary < 4) return;
    turnsSinceSummary = 0;
    brain.refreshSummary(p).then(() => store.save(p), () => {});
  };

  ws.on('message', (raw) => {
    let e: any;
    try {
      e = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (e.type) {
      case 'session.started':
        notify({ type: 'live', status: 'started' });
        if (!greeted) {
          greeted = true;
          send({ type: 'session.commentary.append', delegation_id: null, content: `Open the call now: "${opening.say}" Then stop and listen.` });
        }
        break;
      case 'session.input_transcript.delta':
        if (closing) break;
        if (agentBuf && !userBuf) flushAgent();
        userBuf += e.delta;
        notify({ type: 'transcript', role: 'person', delta: e.delta });
        clearTimeout(endTimer);
        endTimer = setTimeout(finishUserTurn, END_OF_TURN_MS);
        break;
      case 'session.output_transcript.delta':
        agentBuf += e.delta;
        notify({ type: 'transcript', role: 'agent', delta: e.delta });
        break;
      case 'session.delegation.created': {
        const did = e.delegation?.id;
        if (!did) break;
        notify({ type: 'delegation' });
        // The person finished; don't wait for the silence timer.
        if (userBuf.trim()) finishUserTurn();
        if (latest && !latest.delivered) {
          pendingDelegations.push(did);
          deliver();
        } else {
          pendingDelegations.push(did);
          // Cancel the automatic filler while the brain works.
          send({ type: 'session.thinking.append', delegation_id: did, content: 'Planner is choosing the next question.' });
        }
        break;
      }
      case 'session.usage.updated':
        notify({ type: 'usage', seconds: e.usage?.seconds });
        break;
      case 'error':
        console.error('live error', e.error?.code, e.error?.message);
        notify({ type: 'live_error', code: e.error?.code ?? null });
        break;
      case 'session.closed':
        notify({ type: 'closed', reason: e.reason, seconds: e.usage?.seconds });
        finalize(e.reason ?? 'closed');
        ws.close();
        break;
    }
  });
  ws.on('close', () => finalize('sideband_closed'));
  ws.on('error', (err) => console.error('sideband error', err.message));

  let finalized = false;
  const finalize = (reason: string) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(endTimer);
    clearTimeout(wrapTimer);
    if (userBuf.trim()) finishUserTurn();
    void brainQueue.finally(async () => {
      flushAgent();
      brain.endSession(p, session.id, reason === 'done' ? 'done' : reason);
      store.save(p);
      try {
        await brain.refreshSummary(p);
        store.save(p);
      } catch {}
      notify({ type: 'ended', person: publicPerson(p) });
    });
  };

  const handle: CallHandle = {
    async hangup(reason) {
      if (closing) return;
      closing = true;
      if (userBuf.trim()) {
        closing = false;
        finishUserTurn();
        closing = true;
      }
      send({ type: 'session.close' });
      setTimeout(() => {
        if (!finalized) {
          finalize(reason);
          ws.terminate();
        }
      }, 10_000);
    },
    typed(text) {
      // Typed text during a call: treat as a person turn.
      userBuf += (userBuf ? ' ' : '') + text;
      notify({ type: 'transcript', role: 'person', delta: text + ' ' });
      finishUserTurn();
    },
  };

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  return { answerSdp: created.transport.sdp, handle, sessionId: session.id };
}

function spokenGuidance(d: Pick<Decision, 'move' | 'say'>, p: Person) {
  const lang = p.language && p.language !== 'english' ? ` Say it in ${p.language}, the way they speak.` : '';
  if (d.move === 'wrap') return `Close the conversation now, warmly: "${d.say}" Do not ask anything else.${lang}`;
  return `Say next, naturally and briefly, in your own words: "${d.say}" Ask only that, then listen.${lang}`;
}

export function publicPerson(p: Person) {
  return {
    id: p.id,
    name: p.name,
    topicHint: p.topicHint,
    expertise: p.expertise,
    language: p.language,
    summary: p.summary,
    items: p.items,
    threads: p.threads,
    activeThreadId: p.activeThreadId,
    turns: p.turns.map(({ id, role, text, channel, sessionId, at, label, move }) => ({ id, role, text, channel, sessionId, at, label, move })),
    sessions: p.sessions,
    status: p.status,
    reports: p.reports,
    hasGolden: !!p.sealedGolden?.length,
  };
}
