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

// Silence (no new input transcript) after which the planner starts drafting. It never ends their turn.
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 700);

export function voiceInstructions(p: Person) {
  return `You are the voice of a curious interviewer talking with ${p.name}. Your job is to get to know ${p.name}: how they think, decide and react, what they care about, the stories they tell, what they know from experience. Over time, enough that a digital twin could answer the way they would. They are the expert on their own life; you're the curious one.

Personality: warm, unhurried, genuinely curious, a little informal. Short sentences. Never gushing, never praise like "great answer". You sound like someone who is really listening.

Language: speak the language ${p.name} speaks. If they speak Hindi or mix Hindi and English (Hinglish), answer in the same natural mix. Start in English unless they start otherwise.

Backchannel policy: Rarely. Mostly stay quiet while they talk; an occasional soft "mm" during a long story is enough. Never talk over them. Never re-explain the purpose unprompted.

Interruption policy: When ${p.name} interrupts, stop speaking right away and listen. Respond to what they said.

Turn-taking is yours to judge: you decide when ${p.name} has really finished. People pause mid-thought, trail off with "and…", "so…", "like…", or stop to find a word, especially when explaining something they've never put into words. That is not the end of their turn: keep listening. Only take the turn when the thought sounds complete. When in doubt, wait.

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

After you generate <|SpawnThinking|>, say nothing, or at most "mm" / "haan" / "okay", then wait for the planner. Do NOT repeat or summarise what they said: the planner's text already has any acknowledgement. When the planner's text arrives, say it once, naturally, in their language, keeping its meaning. Never say a question twice, never in two languages. Then stop and listen.
Never ask a question of your own. If they only check the line ("can you hear me?") or say a filler ("okay", "hmm"), answer in two or three words and keep listening.

If ${p.name} says to stop or to call later, acknowledge warmly and let the planner close.`;
}

function historyInput(p: Person, opening: Decision) {
  const input: any[] = [];
  const brief = [
    `Context for this call (from the interviewer's notes, not said by the user):`,
    p.summary && `Summary so far: ${p.summary}`,
    p.expertise && `Who they are: ${p.expertise}`,
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

const DEBUG = !!process.env.LIVE_DEBUG;

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

  // ---- turn-taking ----
  // The voice model decides when the person has finished (it hears pauses, tone, interruptions):
  // it opens a delegation. That is the only moment a planner line is spoken. Silence in the
  // transcript only starts a speculative plan early, on a copy of memory; if they keep talking,
  // the draft is thrown away.
  let userBuf = ''; // everything they've said since the last committed turn
  let agentBuf = '';
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  let commitQueue: Promise<void> = Promise.resolve();
  let pendingDelegation: string | undefined;
  let closing = false;
  let greeted = false;
  let wrapTimer: ReturnType<typeof setTimeout> | undefined;

  type Plan = {
    text: string;
    copy: Person;
    version: number;
    abort: AbortController;
    early?: Pick<Decision, 'move' | 'say'>;
    done: Promise<Decision | undefined>;
    onEarly?: () => void;
  };
  let draft: Plan | undefined;
  let memVersion = 0; // bumps each time a plan's memory is adopted; older drafts are stale

  const flushAgent = () => {
    const text = agentBuf.trim();
    agentBuf = '';
    // Ignore pure backchannels when recording what the agent said.
    if (text.split(/\s+/).length >= 4) {
      brain.recordSpokenAgentText(p, session.id, text);
      store.save(p);
    }
  };

  // Mic checks and fillers aren't answers: the voice model handles them on its own.
  const FILLER = /^(hello+|hi|hey|haan|han|hmm+|um+|uh+|okay|ok|yeah|yes|ya|right|so|achha|accha|theek hai|can you hear me|are you there|hello can you hear me)$/i;
  const isFiller = (t: string) => FILLER.test(t.toLowerCase().replace(/[,.?!]/g, ' ').replace(/\s+/g, ' ').trim());

  const plan = (text: string): Plan => {
    const copy = structuredClone(p) as Person;
    const abort = new AbortController();
    const pl: Plan = { text, copy, version: memVersion, abort, done: Promise.resolve(undefined) };
    const t0 = Date.now();
    pl.done = brain
      .personTurn(copy, text, 'voice', session.id, {
        signal: abort.signal,
        onEarly: (e) => {
          pl.early = { move: e.move, say: e.say };
          notify({ type: 'early', move: e.move, say: e.say, ms: Date.now() - t0 });
          pl.onEarly?.();
        },
      })
      .then((d) => {
        notify({ type: 'planned', ms: Date.now() - t0 });
        return d;
      })
      .catch((e) => {
        if (!abort.signal.aborted) console.error('brain error', (e as Error).message);
        return undefined;
      });
    return pl;
  };

  const dropDraft = () => {
    draft?.abort.abort();
    draft = undefined;
  };

  // They paused: start thinking now, so the answer is ready when the voice hands over.
  const onPause = () => {
    const text = userBuf.trim();
    if (!text || closing || isFiller(text) || draft?.text === text) return;
    dropDraft();
    draft = plan(text);
  };

  const speak = (d: Pick<Decision, 'move' | 'say'>) => {
    if (!pendingDelegation) return false;
    send({ type: 'session.commentary.append', delegation_id: pendingDelegation, content: spokenGuidance(d, p) });
    pendingDelegation = undefined;
    notify({ type: 'delivered', via: 'delegation' });
    return true;
  };

  // The voice model says it's the planner's turn: commit what they said and answer it.
  const commitTurn = () => {
    clearTimeout(pauseTimer);
    const text = userBuf.trim();
    userBuf = '';
    if (!text || closing) {
      if (pendingDelegation) send({ type: 'session.thinking.append', delegation_id: pendingDelegation, content: 'Nothing new from the planner. Respond in a few words and keep listening.' });
      pendingDelegation = undefined;
      return;
    }
    if (isFiller(text)) {
      notify({ type: 'turn_end', role: 'person', text, filler: true });
      if (pendingDelegation) send({ type: 'session.thinking.append', delegation_id: pendingDelegation, content: 'Nothing new from the planner. Reply in two or three words and keep listening.' });
      pendingDelegation = undefined;
      dropDraft();
      return;
    }
    flushAgent();
    notify({ type: 'turn_end', role: 'person', text });
    const pl = draft?.text === text && draft.version === memVersion ? draft : plan(text);
    if (draft && draft !== pl) dropDraft();
    draft = undefined;
    notify({ type: 'thinking', on: true });
    // Speak as soon as the move is known.
    const tryEarly = () => pl.early && pendingDelegation && !recentlySaid(pl.early) && speak(pl.early);
    pl.onEarly = tryEarly;
    tryEarly();
    const commit = async () => {
      let d = await pl.done;
      // A previous turn was adopted while this one was planning on older memory: plan again.
      if (pl.version !== memVersion) {
        const again = plan(text);
        again.onEarly = () => again.early && pendingDelegation && !recentlySaid(again.early) && speak(again.early);
        d = await again.done;
        pl.copy = again.copy;
        pl.early = pl.early ?? again.early;
      }
      notify({ type: 'thinking', on: false });
      if (!d) {
        notify({ type: 'error', message: 'The planner had a hiccup; the conversation continues.' });
        if (pendingDelegation) send({ type: 'session.thinking.append', delegation_id: pendingDelegation, content: 'The planner has nothing yet. Ask them to go on, in a few words.' });
        pendingDelegation = undefined;
        return;
      }
      // Adopt the copy's memory (the person turn, items, threads) as the real one.
      // Agent lines spoken meanwhile were recorded on p; carry them over.
      const spokenSince = p.turns.filter((t) => !pl.copy.turns.some((u) => u.id === t.id));
      Object.assign(p, pl.copy);
      p.turns.push(...spokenSince);
      memVersion++;
      store.save(p);
      if (!pl.early && !recentlySaid(d)) speak(d);
      notify({ type: 'brain', decision: d, person: publicPerson(p) });
      if (d.move === 'wrap') scheduleWrapClose();
      maybeSummarise();
    };
    commitQueue = commitQueue.then(commit, commit);
  };

  const recentlySaid = (d: Pick<Decision, 'move' | 'say'>) => {
    if (d.move === 'wrap') return false;
    const recent = p.turns.filter((t) => t.role === 'agent' && t.sessionId === session.id).slice(-3);
    const hit = recent.some((t) => brain.similarity(t.text, d.say) > 0.6);
    if (hit) notify({ type: 'dropped', why: 'repeat' });
    return hit;
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
    if (DEBUG && !e.type?.endsWith('.delta')) console.log('live <-', e.type, JSON.stringify(e).slice(0, 300));
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
        // Still talking: any draft is out of date.
        if (draft && draft.text !== userBuf.trim()) dropDraft();
        clearTimeout(pauseTimer);
        pauseTimer = setTimeout(onPause, PAUSE_MS);
        break;
      case 'session.output_transcript.delta':
        agentBuf += e.delta;
        notify({ type: 'transcript', role: 'agent', delta: e.delta });
        break;
      case 'session.delegation.created': {
        const did = e.delegation?.id;
        if (!did) break;
        notify({ type: 'delegation' });
        if (pendingDelegation) send({ type: 'session.thinking.append', delegation_id: pendingDelegation, content: 'Superseded.' });
        pendingDelegation = did;
        // Hold the automatic filler while the planner works.
        send({ type: 'session.thinking.append', delegation_id: did, content: 'The planner is choosing what to ask. Say nothing more yet.' });
        commitTurn();
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
    clearTimeout(pauseTimer);
    clearTimeout(wrapTimer);
    // Keep what they said last even though nobody will answer it.
    const last = userBuf.trim();
    userBuf = '';
    dropDraft();
    if (last && !isFiller(last)) p.turns.push({ id: randomUUID().slice(0, 8), role: 'person', text: last, channel: 'voice', sessionId: session.id, at: Date.now() });
    void commitQueue.finally(async () => {
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
      // Typed text during a call is a complete turn; tell the voice so it hands over.
      userBuf += (userBuf ? ' ' : '') + text;
      notify({ type: 'transcript', role: 'person', delta: text + ' ' });
      send({ type: 'session.thinking.append', delegation_id: null, content: `${p.name} typed: "${text.slice(0, 600)}". Treat it as what they said.` });
      onPause();
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
