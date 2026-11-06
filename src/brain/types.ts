export type Channel = 'voice' | 'text';

export type Turn = {
  id: string;
  role: 'agent' | 'person';
  text: string;
  channel: Channel;
  sessionId: string;
  at: number;
  // Agent turns: the move the brain chose. Person turns: how the answer was read.
  label?: AnswerLabel;
  move?: Move;
  notes?: string[]; // person turns: note paths it changed
};

// What a person's answer was, as read by the brain.
export type AnswerLabel =
  | 'rich' // a concrete case, a decision with its why, a rule with its exception
  | 'partial' // some substance, missing the why / the outcome / a case
  | 'vague' // generic, textbook, hedged ("you just practise a lot")
  | 'short' // a few words, no content
  | 'idk' // "I don't know / don't remember"
  | 'hostile' // "why do you care", annoyance, pushback
  | 'bored' // flat, disengaged, wants this over
  | 'tangent' // moved to a different subject
  | 'question' // asked the interviewer something
  | 'callback' // "call me later", "I have to go"
  | 'stop'; // wants to end for good

export type Move =
  | 'open' // first contact: find where their expertise is
  | 'resume' // returning: recap + continue the open thread
  | 'deepen' // good answer: go one level deeper (why / what you noticed / exception / outcome)
  | 'dig' // weak answer: same thread, different angle
  | 'switch' // park or close this thread, open another
  | 'redirect' // tangent: acknowledge, bring back (or follow if it's richer)
  | 'explain' // hostile/question: purpose + choice, no pressure
  | 'reflect' // play back a rule ("so the rule is X, except when Y?") to confirm and invite correction
  | 'answer' // they asked something: answer briefly, then continue
  | 'wrap'; // ending: recap + thank + when to continue

// Memory: a tree of short markdown notes, keyed by path ("work/agents/how-they-review").
export type Note = {
  path: string;
  title: string;
  summary: string; // one line, used to find the note
  body: string; // markdown, in their terms, with their words quoted where it matters
  createdAt: number;
  updatedAt: number;
  sessions: string[];
  turns: string[]; // person turns it came from
};

export type NoteOp =
  | { op: 'write'; path: string; title?: string; summary?: string; body: string }
  | { op: 'move'; from: string; to: string }
  | { op: 'delete'; path: string }
  | { op: 'folder'; path: string; description: string };

export type NoteChange = { op: 'add' | 'edit' | 'move' | 'delete'; path: string; from?: string; title: string; summary: string };

export type Session = {
  id: string;
  channel: Channel;
  startedAt: number;
  endedAt?: number;
  endReason?: string;
  liveSessionId?: string;
};

export type Person = {
  id: string;
  name: string;
  topicHint: string;
  createdAt: number;
  updatedAt: number;
  expertise: string; // one line: who they are, as the note-taker sees it
  language: 'english' | 'hindi' | 'hinglish' | string;
  summary: string; // rolling, for context + resume
  background?: { url: string; brief: string; at: number }; // from a link they gave; not said by them
  turns: Turn[];
  notes: Record<string, Note>;
  folders?: Record<string, string>; // folder path -> one-line description
  open: string[]; // what's still most worth learning about them
  sessions: Session[];
  hostility: number; // count of hostile/bored readings, decays on good answers
  status: 'active' | 'paused' | 'done';
  // Sealed golden set for self-tests: never shown to the brain.
  sealedGolden?: string[];
  reports?: SessionReport[];
};

export type SessionReport = {
  sessionId: string;
  at: number;
  report: unknown;
};

// One brain step: what the agent does next.
export type Decision = {
  label: AnswerLabel;
  move: Move;
  say: string; // full utterance (text channel / guidance for voice)
  question: string; // just the question part
  reason: string; // why this move, for the thinking panel
  changes: NoteChange[];
};
