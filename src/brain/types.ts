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
  threadId?: string;
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

export type Angle = 'case' | 'contrast' | 'options' | 'novice' | 'example_answer' | 'timeline';

export type ItemKind =
  | 'case' // a specific episode
  | 'decision' // a judgement call (with why)
  | 'rule' // rule of thumb
  | 'exception' // when the rule doesn't hold
  | 'cue' // what they notice that others miss
  | 'disagreement' // where they differ from common advice
  | 'outcome'
  | 'howto'
  | 'person'
  | 'context';

export type Item = {
  id: string;
  kind: ItemKind;
  text: string;
  why?: string;
  // Would a generic model already say this? 'textbook' = yes; 'new' = this person's delta.
  novelty: 'new' | 'textbook';
  evidence: string; // a short quote from the person
  threadId?: string;
  turnId: string;
  sessionId: string;
  at: number;
};

export type Thread = {
  id: string;
  title: string;
  status: 'active' | 'open' | 'parked' | 'done' | 'thin';
  // Weak answers in a row on this thread since the last good one. Capped in code.
  weakStreak: number;
  anglesTried: Angle[];
  turns: number;
  emptyTurns: number; // consecutive person turns that added no new item
  gaps: string[]; // what's still missing on this thread (e.g. "why she chose X")
  createdAt: number;
};

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
  expertise: string; // where this person's deep knowledge is, discovered in the conversation
  language: 'english' | 'hindi' | 'hinglish' | string;
  summary: string; // rolling, for context + resume
  turns: Turn[];
  items: Item[];
  threads: Thread[];
  activeThreadId?: string;
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
  angle?: Angle;
  threadId?: string;
  say: string; // full utterance (text channel / guidance for voice)
  question: string; // just the question part
  reason: string; // why this move, for the thinking panel
  newItems: Item[];
  enforced?: string; // what code overrode, if anything
};
