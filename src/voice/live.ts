// GPT-Live is the interviewer: it holds the conversation like a person (when to speak, when to wait,
// what to say). A note-taker (OpenRouter) listens to each finished turn in the background: it updates
// memory and the panel, and briefs the voice silently on what's still worth learning.
//
//   browser --SDP offer--> server --POST /v1/live/sessions--> OpenAI; audio flows browser <-> OpenAI.
//   server attaches a sideband WebSocket to the same session:
//     transcript deltas -> turns -> note-taker -> memory + panel + session.thinking.append(brief)

import { randomUUID } from 'node:crypto';
import * as brain from '../brain/brain.ts';
import type { Decision, Person } from '../brain/types.ts';
// Runs on Node (ws) and on Cloudflare Workers (fetch upgrade): the caller supplies the socket.
export type Socket = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
};
export type Connect = (url: string, headers: Record<string, string>) => Promise<Socket>;
export type Saver = { save(p: Person): void };
import { CRAFT, PURPOSE } from '../brain/prompts.ts';

const API = 'https://api.openai.com/v1';
export const VOICE_MODEL = process.env.VOICE_MODEL ?? 'gpt-live-1';
export const VOICE = process.env.VOICE ?? 'marin';


export function voiceInstructions(p: Person) {
  return `You are a curious interviewer on a voice call with ${p.name}. ${PURPOSE} They are the expert on their own life; you're the curious one.

${CRAFT}

Personality: warm, unhurried, genuinely curious, a little informal. Short sentences, plain words. Never gushing, never praise like "great answer". You sound like someone who is really listening.

How you talk:
- One short question at a time. No add-on second question.
- Acknowledge only when it adds something; never repeat back what they just said, never summarise them to themselves.
- Never re-ask something already answered. Never re-explain the purpose unprompted.
- Speak the language ${p.name} speaks; if they mix Hindi and English, mix the same way. Start in English unless they start otherwise.
- If they just check the line or say a filler, reply in a couple of words and wait.
- If they ask you something, answer briefly and honestly, then carry on.
- If they want to stop or talk later: a short warm goodbye (one line on something you took from the talk), no new question.

Turn-taking: you judge when ${p.name} has finished. People pause mid-thought, trail off ("and…", "so…"), or stop to find a word, especially when putting into words something they never have. That is not the end of their turn: keep listening. Take the turn only when the thought sounds complete; when in doubt, wait. Backchannels rarely; mostly stay quiet while they talk. If they start talking while you speak, stop and listen.

Notes: a note-taker listens along and sometimes sends you silent notes: what has been captured, what's still worth learning, and a suggested direction. They are not said by ${p.name}. Use them when they fit the moment, in your own words; what ${p.name} just said always comes first.`;
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
  store: Saver;
  connect: Connect;
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

  const ws = await opts.connect(`${API.replace('https', 'wss')}/live/sessions/${encodeURIComponent(liveId)}/attach`, { Authorization: `Bearer ${key}` });
  let open = true;

  const send = (event: Record<string, unknown>) => {
    if (open) ws.send(JSON.stringify({ event_id: randomUUID(), ...event }));
  };

  // ---- turns ----
  // The voice model owns the conversation. A person turn is everything they said until the
  // interviewer really replies (a few words, not a backchannel); that turn goes to the note-taker.
  let userBuf = '';
  let agentBuf = '';
  let notesQueue: Promise<void> = Promise.resolve();
  let closing = false;
  let greeted = false;
  let wrapping = false;
  let wrapTimer: ReturnType<typeof setTimeout> | undefined;
  let lastAudioAt = Date.now();
  let openerPlanned = true;

  const recordAgent = () => {
    const text = agentBuf.trim();
    agentBuf = '';
    if (!text) return;
    const last = p.turns[p.turns.length - 1];
    if (openerPlanned && last?.role === 'agent') last.text = text; // what it actually said, not the planned opener
    else p.turns.push({ id: randomUUID().slice(0, 8), role: 'agent', text, channel: 'voice', sessionId: session.id, at: Date.now(), threadId: p.activeThreadId });
    openerPlanned = false;
    store.save(p);
  };

  // Their turn is over: take notes in the background and brief the voice. Nothing waits on this.
  const takeNotes = () => {
    const text = userBuf.trim();
    userBuf = '';
    if (!text) return;
    notify({ type: 'turn_end', role: 'person', text });
    const run = async () => {
      notify({ type: 'thinking', on: true });
      const t0 = Date.now();
      try {
        const d = await brain.personTurn(p, text, 'voice', session.id, { recordAgent: false });
        store.save(p);
        notify({ type: 'brain', decision: d, person: publicPerson(p), ms: Date.now() - t0 });
        if (d.move === 'wrap') startWrap();
        else send({ type: 'session.thinking.append', delegation_id: null, content: brief(d, p) });
        maybeSummarise();
      } catch (e) {
        console.error('notes error', (e as Error).message);
      } finally {
        notify({ type: 'thinking', on: false });
      }
    };
    notesQueue = notesQueue.then(run, run);
  };

  // They asked to stop: the voice says goodbye on its own; close once the line goes quiet.
  const startWrap = () => {
    if (wrapping) return;
    wrapping = true;
    const t0 = Date.now();
    const check = () => {
      if (Date.now() - lastAudioAt > 4000 || Date.now() - t0 > 25_000) void handle.hangup('later');
      else wrapTimer = setTimeout(check, 500);
    };
    wrapTimer = setTimeout(check, 2000);
  };

  let turnsSinceSummary = 0;
  const maybeSummarise = () => {
    if (++turnsSinceSummary < 4) return;
    turnsSinceSummary = 0;
    brain.refreshSummary(p).then(() => store.save(p), () => {});
  };

  ws.onMessage((raw) => {
    let e: any;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    if (DEBUG && !e.type?.endsWith('.delta')) console.log('live <-', e.type, JSON.stringify(e).slice(0, 300));
    switch (e.type) {
      case 'session.started':
        notify({ type: 'live', status: 'started' });
        if (!greeted) {
          greeted = true;
          send({ type: 'session.commentary.append', delegation_id: null, content: `Open the call now, in your own words but keeping the meaning: "${opening.say}" Then stop and listen.` });
        }
        break;
      case 'session.input_transcript.delta':
        if (closing) break;
        lastAudioAt = Date.now();
        // They're talking over or after the interviewer: what it said so far is its turn.
        if (agentBuf.trim()) recordAgent();
        userBuf += e.delta;
        notify({ type: 'transcript', role: 'person', delta: e.delta });
        break;
      case 'session.output_transcript.delta':
        lastAudioAt = Date.now();
        agentBuf += e.delta;
        notify({ type: 'transcript', role: 'agent', delta: e.delta });
        // A real reply (not "mm") means their turn has ended.
        if (userBuf.trim() && agentBuf.trim().split(/\s+/).length >= 3) takeNotes();
        break;
      case 'session.delegation.created': {
        // Not used (no delegation configured); release it so the voice never waits on us.
        const did = e.delegation?.id;
        if (did) send({ type: 'session.thinking.append', delegation_id: did, content: 'Nothing to add. Carry on.' });
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
  ws.onClose(() => {
    open = false;
    finalize('sideband_closed');
  });

  let finalized = false;
  const finalize = (reason: string) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(wrapTimer);
    // Notes on whatever they said last, even though nobody will answer it.
    if (agentBuf.trim()) recordAgent();
    takeNotes();
    void notesQueue.finally(async () => {
      if (agentBuf.trim()) recordAgent();
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
          ws.close();
        }
      }, 10_000);
    },
    typed(text) {
      // Typed during a call: it's their turn, as if said aloud.
      if (agentBuf.trim()) recordAgent();
      userBuf += (userBuf ? ' ' : '') + text;
      notify({ type: 'transcript', role: 'person', delta: text + ' ' });
      send({ type: 'session.commentary.append', delegation_id: null, content: `${p.name} typed this instead of saying it: "${text.slice(0, 1500)}". Respond to it as if they had said it.` });
    },
  };

  return { answerSdp: created.transport.sdp, handle, sessionId: session.id };
}

// The silent note for the voice after each turn: what's new, what's left, a suggested direction.
function brief(d: Decision, p: Person) {
  const lines = ['Note from the note-taker (silent, not said by them):'];
  if (d.newItems.length) lines.push(`Just captured: ${d.newItems.map((i) => i.text).join(' | ')}`);
  const gaps = p.threads.find((t) => t.id === d.threadId)?.gaps ?? [];
  if (gaps.length) lines.push(`Still open here: ${gaps.join('; ')}`);
  lines.push(`Suggested direction: ${d.reason}${d.question ? ` For example: "${d.question}"` : ''}`);
  if (p.language && p.language !== 'english') lines.push(`They speak ${p.language}.`);
  return lines.join('\n').slice(0, 1800);
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
