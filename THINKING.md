# THINKING.md: an experiment log

The question: how do you get what makes a person *themselves* out of their head (how they decide, what they put first, what they notice, their rules and the exceptions, how they react and talk) and into a form that a digital twin could use to answer the way they would? It has to work for any human: an engineer, a nurse, a grandmother who cooks by feel.

This file records what I believed, how I tested it, what broke, and what I changed. The build is the instrument; this log is the work.

---

## 0. Starting position (hypotheses)

| # | Hypothesis | Why I believed it |
|---|---|---|
| H1 | Only the delta matters. A base model already knows the textbook and the "typical" answer; the value is where this person differs. | A twin built from generic answers is just the base model. |
| H2 | Tacit knowledge can't be asked for directly. It comes out through a specific case, a contrast or a decision, not through "what do you know about X". | People can't list their own rules of thumb; they show them in a story. |
| H3 | A vague answer is usually knowledge that has never been put into words, not laziness. The fix is a different angle, not pushing harder. | It's the core finding of cognitive task analysis and of "laddering" interviews. |
| H4 | Engagement comes from being genuinely interested and building on what they said, not from technique. People should feel they are teaching, not being tested. | Every interview study that reports drop-off blames feeling interrogated. |
| H5 | Voice is the main channel because people explain judgement by talking. Text should use the same brain. | Talking is cheaper than typing for the person, and richer. |
| H6 | It's a relationship, not a session: "call me later" should pick up the next gap, never restart. | Nobody gives their whole self in one sitting. |

The metric I care about: **how much of what makes them themselves gets captured per minute of their time, while they still want to come back.**

---

## 1. Experiment 1: v1 on a real person (Utkarsh, voice, 6 Nov)

**Design (v1).**
- A planning brain (Claude Sonnet via OpenRouter) read each answer, labelled it (rich / partial / vague / short / …), chose a move (deepen / dig / switch / …) and wrote the exact line to say.
- The voice model (OpenAI `gpt-live-1`) only spoke what the brain wrote.
- A server-side silence timer (~1.1 s) decided when the person had finished.
- Code enforced the craft: a cap of 2 digs per thread, one question mark per turn, a repeat detector (string similarity) and filler regexes.
- The prompt's main craft rule was "get one concrete episode".

**What happened** (stored transcript, 36 person turns, 38 interviewer turns, 2 sessions):

| Measure | Value |
|---|---|
| Person turns read as `short` or `vague` | 16 / 36 (44%) |
| Person turns of ≤ 3 words | 31% (mostly ASR fragments of one longer thought) |
| Interviewer moves that were `dig` | 16 / 38 |
| Near-verbatim repeated interviewer questions | 4 |
| Mean interviewer turn | 30 words |
| How it ended | "You are annoying me, man. You are annoying me. You are, are cutting me off", then "Let's stop now" |
| Items captured | 21, of which 20 were judged non-textbook |

Utkarsh's feedback after the call:
- "it drilled down too much to specific situations … it didn't feel like the questions were necessary"
- "takes a while for it to know what I said"
- The topic field and the sealed facts in the UI were noise: "we are creating a twin so it can be anything, even things on a deeper level".

**What I learned.**
1. **The failure was turn-taking, and it cascaded.** A 1.1 s silence timer cut one thought into 3-word fragments. The brain read each fragment as a `short` answer and dug harder, which made it ask the same thing again (4 repeats). They were never giving short answers; they were mid-sentence. H3 was right about people, but my system couldn't tell a pause from an answer.
2. **The capture idea works even when the conversation feels bad.** The items are real tacit knowledge a base model would not guess:
   - they check an agent's work by asking for a *video* rather than reading code;
   - they deliberately give *non-specific* fix instructions outside their expertise, because "it takes that instruction very literally … it doesn't use its own brain knowledge";
   - they look for "errors it saw but ignored".

   H1 and H2 hold.
3. **"Get a concrete episode" applied every turn is interrogation.** Once an answer already gives the view and the reason, another episode adds nothing for a twin. Episodes are a tool for *vague* answers only.
4. **The person in the transcript is not the spec.** My copy and prompts had picked up example phrases from the brief, such as a recipe and "things you've done many times". Utkarsh called that slop. The interviewer must be generic: any human, any subject.

**Changes →** Experiments 2–4.

---

## 2. Experiment 2: who owns the turn? (fake-mic voice tests)

**Hypothesis.** The voice model hears prosody, hesitation and intonation; my server hears only silence. So the voice model should decide *when* to speak and *how* to say it. The planning brain should become a silent note-taker that briefs it, not a script writer.

**Test.** An automated browser call with a fake microphone. I recorded TTS clips (an opener reply, a filler "mmh", a vague answer, rich answers) and played them into the live session through WebAudio, then measured the gap from the end of each clip to the start of the interviewer's reply.

| Design | Reply latency after an answer | Filler "mmh" | Notes |
|---|---|---|---|
| Brain dictates every line (`logs/voice-test5`) | 2.4–7.8 s | — | The voice model sometimes spoke its own line *and then* the dictated one: two questions interleaved. |
| Voice model leads, brain briefs silently (`voice-test7`) | 0.9–1.5 s | No reply (correct) | One question per turn. The brief's suggested direction showed up in the next question about half the time, in the voice model's own words. |
| Same, on Postgres (`voice-test-pg1`) | 1.1–1.7 s | No reply | — |
| Same, hosted on Cloudflare Workers (`voice-test-cf-hosted1`) | 1.1–1.3 s | No reply | Notes and the "learned" panel updated live. |
| With note-tree memory and the breadth nudge (`voice-test-ui1`) | 0.7–2.3 s | No reply | **Two questions per reply came back:** "…change the steps, or laugh it off? Okay, that's useful. Outside the chai, what does your day look like?" |
| Brief marked "for your next turn" (`voice-test-ui2`) | 0.9–1.9 s | No reply | One question per reply again. Hinglish answered in Hinglish; "call me later" closes in one line. |

**Result.** Latency dropped 2–5× and the cut-in fragments disappeared. The note-taker still does all the capture: it reads the full answer after the voice model has responded, updates memory and sends a silent `session.thinking.append` brief ("just captured / still open here / suggested direction"). A person's turn now ends when the voice model actually replies with a few words, not when a timer fires.

**Cost.** The planner no longer controls exact wording, so a good idea in a brief can be ignored. I accept this. A late question is worse than a different question.

**A failure this exposed.** The voice model parroted one generic line from the prompt ("does this show up in other parts of your life?") because the craft rule contained it literally. I removed the literal question and kept the principle (move to the bigger pattern, asked about the specific thing they said).

**A second failure, after the breadth nudge.** The brief lands about 4 s after an answer, and by then the voice model has usually replied. Once the brief started carrying "whole areas not touched yet", the voice model would finish its own question and then tack on the brief's new topic. The fix is timing, not content: the brief now says it is for the *next* turn, and the voice instructions say never to add a second question because of a note. The same test showed a UI bug with the same root cause: the person's final transcript arrives after the reply has started, which split one reply across two lines.

---

## 3. Experiment 3: code rules vs model judgement

**Hypothesis.** Every rule I had put in code (dig caps, the repeat detector, question trimming, filler regexes, a forced "safe" question after too many weak answers) was a guess about human behaviour made without context. The model sees the whole conversation and can make that judgement better.

**Evidence that it was needed.** Each code rule broke something human in testing:
- trimming to one question mark cut off half a sentence;
- the repeat detector blocked a legitimate re-angle;
- the dig cap fired on a person who was enjoying the thread;
- the filler regex ate "hmm, actually…" openings.

Utkarsh's feedback: "think like a real product person … not stupid code brittle solution … rely a lot on agent judgement".

**Change.** Code now only moves data, keeps memory and checks shape (valid JSON, a question present). All behaviour lives in two prompts that share one statement of purpose and eight craft principles:
1. only the delta;
2. every question earns its place;
3. vague → concrete, a different angle each time, two tries;
4. breadth and depth;
5. hostile → purpose plus a choice;
6. not an interrogation, no praise;
7. any human, no question list;
8. a relationship across sessions.

The model gets *facts* about the turn (thread length, turns so far), not orders.

**How I check it didn't regress:** Experiment 6 (simulated people), where repeated questions, over-drilling and pushing after pushback are measured explicitly.

---

## 4. Experiment 4: whole person, minimal surface

- The start page is just a name, an optional link and Call. There is no topic field: a real user won't type one, and the interviewer should find where their depth is.
- What gets captured was widened from "expertise" to the whole person. Items are typed as: story, decision (+ why), value, belief, rule, exception, cue, reaction, style, relationship, fact. Each item needs an exact quote of their words as evidence, and is marked `new` or `textbook`. Textbook items are kept but shown greyed, because they are worth little to a twin. *(Replaced in Experiment 7: typed items turned out to be the wrong shape.)*
- There is one End call button. Ending always saves, so the next call resumes. Saying "call me later" by voice also works.
- A "Read only" toggle mutes the interviewer's voice during a call, for people who would rather read and type.

---

## 5. Experiment 5: a head start from a link

**Hypothesis.** The first two minutes of a call are spent finding out who someone is. A public link (personal site, profile) can skip that, *if* it's used to ask better questions and never treated as something they said.

**Design.** The page is fetched, and a fast model writes a note of at most 100 words. The note goes into context under "Background from a link they gave (public web, NOT said by them)", with the instruction: ask rather than assume, and never capture it as an item.

**Result.**
- **Before:** the opener ignored the background, because my first wording said "don't state it as fact" and the model played safe.
- **After rewording** (you can say you had a look): "I had a look at your site. You studied painting after computer science. What did painting teach you that programming never did?" That is a question only that person can answer, about something real.
- **Limit:** LinkedIn blocks server fetches, so the most common link fails. It degrades to a normal opener.

---

## 6. Experiment 6: simulated people, ours vs a baseline

**Why.** Experiments 1 to 5 were judged by eye on a handful of calls. To compare designs I needed a number that doesn't depend on me reading transcripts.

**Setup** (`eval/run.ts`, results on `/eval`):
- **Four simulated people,** each with 10 to 12 hidden facts about themselves (`eval/scenarios/personas.json`). Each fact is tagged by how hard it is to get: volunteered freely, given when asked, only on a probe, or only once there's trust. The people also differ in behaviour:
  - Meera: a retired principal, eager.
  - Arjun: terse.
  - Kamla: vague, in Hinglish.
  - Sam: hostile at first, then warm.
- **The person** is played by GPT, and is told to reveal facts only as their disclosure level allows.
- **The interviewer** is either:
  - *ours:* the real text channel (Room + brain + memory), not a copy; or
  - *baseline:* what you'd build first, which is the same Claude model with one sensible interviewer prompt and the chat history.
- **Each run** is 12 answers, with a "call me later" after 6 and then a second session, to test resume.
- **The judge** is Gemini, a different family from both the interviewer and the person, to avoid self-preference. It marks each hidden fact as said / partial / not said, with an exact quote. For *ours* it also marks whether the fact made it into memory. It lists interviewer mistakes: repeated questions, praise, over-drilling, ignored answers, pushing after pushback. It also checks whether the second session remembered the first.

**Run 1: v1 (typed items, threads) vs baseline.** This was a negative result.

| | ours v1 | baseline |
|---|---|---|
| facts drawn out | 0.12 | **0.18** |
| vital facts | 0.08 | **0.10** |
| hard-to-get facts | 0.11 | **0.14** |
| annoyance (1–5) | **1.19** | 1.30 |
| praise | **0** | 27 |
| words per question | **22** | 44 |

Ours was the better *conversation*: no praise, half the words, less annoying. But it learned less. The transcripts show why. With Meera, all 13 questions were about her tutoring two girls: how she decides when to step in, a time she lost patience, how she was with maths as a child. She is also a widow, a mother, a retired principal with a hard decision behind her, and none of that came up. The craft rules ("go deeper while it adds something") plus a thread tracker kept rewarding depth on whatever topic was live. The baseline, being dumber, wandered, and wandering covers more of a person.

**Run 2: note-tree memory (Experiment 7) plus a breadth nudge.** I added one sentence to principle 4: *"Their notebook shows what you have: if most of it sits in one folder, the next good question is probably somewhere else."* The "still most worth learning" list was also told to *"include whole areas of their life not touched yet"*. Both are judgement prompts, not code rules. The note tree makes "where is everything I know" visible at a glance, which typed items never did.

| | **ours (notes)** | ours v1 | baseline |
|---|---|---|---|
| facts drawn out | **0.23** | 0.12 | 0.18 |
| vital facts | **0.18** | 0.08 | 0.10 |
| hard-to-get facts | **0.25** | 0.11 | 0.14 |
| saved to memory | **0.23** | 0.12 | – |
| annoyance (1–5) | **1.15** | 1.19 | 1.30 |
| praise | **0** | 0 | 27 |
| re-asked after resume | 2 | 1 | **0** |
| cost for 4 people | $1.00 | $0.71 | $0.25 |

Per person: Arjun 14% → 31%, Meera 6% → 24%, Sam 16% → 22%, Kamla 13% → 16%.

Meera's second run went from her tutoring to her years as principal, her husband, her son in Bangalore, her evenings and her friends. "Saved to memory" equals "drawn out", so everything she said made it into the notes: the note-taker lost nothing.

**How much to trust this.**
- It's one seed per person, and runs 1 and 2 were on different days. The simulated people are random, so a single persona can swing ±10 points (the baseline scored 3% on Sam and 25% on Kamla).
- Run 2 changed two things at once (memory and the breadth nudge), so I can't split the credit.
- Kamla, who is vague and speaks Hinglish, barely moved. Vague people are where the craft matters most, and I haven't cracked it.
- Ours re-asked something after resuming twice. The baseline never did, because it simply has the full chat history.
- Simulated people are more forthcoming than real ones. These numbers rank designs; they don't predict real recall.
- I stopped at a $5 total budget. With more, I'd run 3 seeds per persona with both arms in the same run, and add one sim from a second model family.

**What it changed in the design.** Breadth needs to be something the model can *see*, not just a rule it's told. Every later decision about memory shape was made with that in mind.

---

## 7. Experiment 7: memory as a notebook, not a database

**What was wrong.** v1 stored typed items: story, decision, value, rule, exception, cue and so on. Each had a quote, and they were grouped into threads. Looking at real records, three problems showed up:
- **The categories were mine, not theirs.** "Prefers videos to reading output" is a habit, a rule and a value at once. The model spent effort choosing a type, and the twin gains nothing from the label.
- **It stored the conversation, not the person.** Items like "asked about X, they said Y", "dislikes being cut off" (a reaction to my interviewer, not a fact about them) and "had to pause the call".
- **Flat lists don't scale.** After a few calls it's 80 unordered items, and neither the model nor a person can see what's known about any one area.

Utkarsh's feedback was simply: let it write files.

**Design.** Memory is a folder tree of short markdown notes, any depth: `work/agent-practice/verifies-via-video`, `family/son`, `values/...`.
- **Each note** has a title, a one-line summary and a body.
- **Each folder** has a one-line description, so a scan of the tree says what's where without opening anything.
- **Per turn,** the note-taker sees the tree with every summary, plus the full bodies of the most recently touched notes (up to 14k characters). It returns operations: `write` (replace the whole note), `move`, `delete`, or `folder` (set a description). It can only rewrite a note whose body it can see, so it can never blindly overwrite text it hasn't read.
- **After each call,** a consolidation pass reads the whole tree against the transcript. It merges overlaps, fixes anything the turn-by-turn notes got wrong, reorganises, and updates "who they are" and "still most worth learning".
- **The rules** (`MEMORY_RULES`, shared by both passes):
  - Notes are about the person, never the conversation.
  - If they correct my premise ("I asked X; actually Y"), store only Y; X never appears.
  - Use their words where the wording matters.
  - Don't psychologise.
  - Use their name or "they", never a guessed pronoun.
  - A rewrite may never lose a detail.
  - If they change their mind, keep both views, dated.
- **No RAG and no agent framework.** One model call per turn returns JSON operations. A person's notebook from a few hours of talk fits easily in context, and retrieval would add a way to miss things without adding anything else. The scaling path is in section 9.

**Evidence.**
- **Utkarsh's v1 voice call, rebuilt from its transcript:**
  - It produced `work/agent-practice/` with three notes: how they correct the agent through its memory; why specific instructions backfire where they lack expertise ("doesn't use its own brain knowledge"); and verifying work by asking for a video rather than reading output.
  - Each note keeps their words, the example (500 errors on a customer setup) and an "unfinished" marker for what's still open.
  - It contains no notes about call logistics or about the interviewer. The v1 items for the same call included both.
- **The hosted record** whose only turns were "What's up bro" and pauses rebuilds to *no notes*, which is correct.
- **A typed test person:**
  - Each answer adds or edits notes in 3.6 to 4.4 s.
  - Repeating the same answers in a later session wrote nothing new.
  - Answering "no face in the water on day one" edited the existing `day-one-rule` note instead of creating a second one.
- **The eval (section 6):** facts drawn out went 0.12 → 0.23, and everything said was saved.

**Known weaknesses.**
- **A note is a paraphrase.** A twin should get the notes *and* the raw transcript; the notes are the index and the transcript is the evidence.
- **Repeated rewrites can drift.** The "never lose a detail" rule and the after-call pass both push back against this, but nothing measures it yet.
- **Contradictions are kept with dates, but nothing yet asks the person which view still holds.**

---

## 8. Experiment 8: the interface is part of the interview

v1's UI looked like a debug console: chips, labels, a "why this question" box. People talk differently when they feel watched by a dashboard.

- **Start page:** "Hi. What's your name?", then *Start talking* or *or type instead*. The link box is folded away.
- **During a call:**
  - The conversation fills the screen, with a presence orb that follows both voices' audio levels, so you can see it's listening.
  - The notebook sits beside it. New and changed notes are tagged and scroll into view, so the person can *see* they're being understood. That is the cheapest trust-builder I found.
  - On a phone, the notebook is a bottom sheet.
- **After a call:** their notebook (downloadable as markdown) and a short review of the conversation: what it learned, what to ask next time, and what's still missing. The review is written by the judge model, so it's honest. It once said of a test session that "this turn added almost nothing new because Asha repeated earlier points", which was true.
- **People page:** each person's notebook and every past conversation.

---

## 9. Experiment 9: deep, but on the wrong thing (Utkarsh, voice, 6 Nov evening)

**What happened.** About 5 minutes in Hinglish. In one answer Utkarsh mentioned work, an interview, office work and moving. The interviewer picked "how do you decide what to do first" and stayed there for five questions: urgent first, then the small task first, then that it feels good, then the procrastination. Every answer was captured faithfully in the notes. Utkarsh's verdict: "its going deep but that deep is not that useful… it can do some breadth first".

**Why that's right.** "Urgent first, small things first, I procrastinate a bit" is close to what a base model would guess for anyone. The craft already said "only the delta matters" (§0), but nothing told the interviewer *where* to look for the delta. Faced with a list, it took the topic that was easiest to probe, the routine, not the one that says most about the person, the move. The genuinely distinctive line ("automate everything that takes effort, protect whatever gives pleasure") got one follow-up that drew an "I don't know", then was dropped.

**Change.** Principle 5 is now *breadth first, then depth where it pays*. While the notebook is thin, sketch the map of their life: what they do, where they're heading, the people who matter, what they spend time on, what they're deciding now. Then go deep only where an answer shows something a generic model wouldn't guess. When one answer lists several things, choices in their life beat routines. This is still guidance to the model, not a code rule (§3).

**Evidence (replay, $0.25).** I replayed the real call through the note-taker, holding the real interviewer lines fixed, and recorded what it would ask after each of the first 8 answers.

| after | old principle | new principle |
|---|---|---|
| "did some work, did an interview, office work, moving places" | "Which one felt like the biggest drag today?" | "You said you're moving places. Where are you moving to?" |
| "jo bhi zyada urgent hai, woh karta hoon" | "Aaj ke teen kaam mein se urgent kya tha, aur kaise pata chala?" | "Achha, shifting kahan ho rahi hai, aur kyun?" |

The other 6 questions were near-identical in both. The old prompt drills into urgency; the new one goes to the life decision. One replay of one person is thin evidence: the next real call is the test.

## 10. Experiment 10: what the competitor asks (TwinCafe, hands-on, 6 Nov)

Utkarsh's next note: TwinCafe "asks valuable stuff, like I'm an AI engineer, so it tries to capture that", while ours "is trying to make my twin, which is amazing, but it asks things that aren't even relevant, digs deep and expects short answers". So I used TwinCafe on his account. I spoke to its story interview through a fake mic (macOS TTS, Indian English), saved the result, asked the twin preview outsider questions, then deleted the test story.

**What they do.**
- Everything is framed around what other people will ask the twin. Each suggested topic says "Helps answer questions about…".
- The story interview picks from 12 topics generated from his LinkedIn, all of them expertise ("agent memory", "evaluating coding agents", "orchestration failures"…). Its first question was specific to his job: "what made agent memory actually useful in your ANZ engineering workflow agents?". The follow-ups were good, and it matched his Hinglish.
- It stays locked to one topic. When I asked to switch, it said "let's wrap this memory thread quickly". About 4 questions in 6 minutes, ending on "stop".
- What it stores is the raw transcript as one source item, with speech-to-text errors and call logistics included. Nothing is extracted or organised.
- Twin preview, five outsider questions:
  - It used the story right away and accurately.
  - "Startup or big company?" got polished generic advice.
  - Hobbies and the move got "I haven't shared that…".
  - "Everything is urgent, what do you do?" got a confident senior-engineer answer that differs from what Utkarsh actually said in our call ("urgent first, small first, I procrastinate a bit"). So the personal layer is exactly where a twin falls back to a generic person.

**What that says.** They're right about *whose questions matter*: the people talking to the twin, who mostly come for the person's work and expertise. We're right that the twin needs more than expertise, because their twin either hedges or invents on everything personal. Our interview went wrong on priority, not on reach. It treated a morning routine as being as worth asking about as his field. And its narrow questions ("which one was urgent today?") invited one-line answers.

**Change.**
- The purpose now names the audience: colleagues, people wanting advice, people deciding whether to work with them, friends. What they'd ask comes first.
- Principle 2's check is now "would someone talking to their twin plausibly need this?". Private routines rarely pass.
- Principle 5 now starts with what they're known for, then breadth, then depth.
- Principle 3 asks for open questions that leave room to talk at length, and says a long answer is the goal.
- The opener asks about what they do or are known for.
- We keep what TwinCafe lacks: no fixed topic, switching when asked, live follow-up on anything they bring, an organised notebook instead of a raw transcript, and life beyond work once the core is in.

**Evidence (replay of the same real call, first 4 answers, $0.03).** After "automate everything except what gives me pleasure → I don't know", the old prompt asked about the day's three tasks. The new one asks "What do you do day to day, like work or studies?", which is the question TwinCafe got from LinkedIn for free. With a link, the opener already starts from their background (§5). This is one replay. A real call is the test.

**A second lesson, on how it feels.** Utkarsh about TwinCafe's flow (pick a topic, then answer a set of questions): "it's tiring, people will leave". A run of bare questions reads as a questionnaire whatever the questions are. Ours already has no topic to pick. But after the repeat-back complaints (§9), our ack rule had swung to "empty is often best", which pushes toward exactly that run of bare questions. The rule now asks for a short genuine reaction before the question when one comes naturally: a thought the answer sparks, a link to something they said earlier, a light remark. It still never restates what they said.

**Other ways in (light, the model's call).** From ideas Utkarsh liked, CRAFT now names three alternatives to a plain question, offered as options rather than rules:
- make a confident guess about how they'd see or do something and let them correct it (a wrong guess finds the delta);
- play someone who'd come to them (a junior asking advice, a client) so they answer in character;
- put a sharp take from their world to them.

The goodbye now names one thing about them that surprised the interviewer, something a stranger wouldn't have guessed. That rewards their time, and it shows the delta was heard. In a replay of the first 8 answers, the questions now follow what they're doing (work, the move, the interview, then their office work) instead of their routine. The new moves didn't fire there, which is fine: they're for when they fit.

**Tools they already use (optional connectors).** This was Utkarsh's idea. A person can connect a tool they work in: Notion, Granola, Linear, Jira and Confluence, ClickUp or Airtable. They are plain buttons with logos; the protocol never shows. Gmail and Calendar would need our own Google OAuth app, so they are not in yet (a Zapier route worked, but it is a confusing extra sign-in, so it's out).
- It's a real MCP client: OAuth 2.1 with dynamic client registration and PKCE, over Streamable HTTP. Servers that need a pre-registered app (Slack, Google, GitHub, Asana's v2 server) are left out rather than faked. Sign-in redirects were checked against every preset.
- An agent (Haiku, at most 24 steps) gets only the server's read-only tools, plus a pen for its own notebook. It reads the way a new colleague catches up: broad first, in time order, then writes the gist of what they work on, with "worth asking" lines. That notebook is kept apart from the interview notes. The interviewer sees it marked "read by an assistant, NOT said by them", and uses it to ask the why behind what the tools show: the data gives the what, the interview gives the why.
- Privacy: it's optional, and the interviewer mentions it at most once. The notes are gist, not secrets. The person sees every note and can strike any of them. Nothing is written back to their tools. Tokens stay server-side and are never sent to the browser.
- It keeps the profile current: on a visit more than a day after the last read, the agent reads again from its old notes and changes since then, and updates or deletes what's no longer true.
- It fits where Viven is going, since a twin at work will sit on top of work tools anyway. It also doesn't exclude "any human": without tools, the interview works as before.
- Not tested end to end with a real account. That needs someone to sign in; sign-in and the UI were checked, but the read loop wasn't.

## 11. What I'd do next

- **Twin-gap questions.** Ask a cheap model "what would people who know this person's work ask their twin that these notes can't answer?", and feed the top gap to the note-taker as a direction. This is TwinCafe's "see what it missed" loop, but before the twin exists.
- **The twin test (idea only, not built).** This is the real measure of capture. Hold out questions the interview never asked ("would you take this job?", "how would you reply to this message?"). Build a minimal twin from the captured notes only, and score its answers against the person's own. Report how often it abstains as well as how accurate it is: a twin that says "I don't know" beats one that invents. The facts-recall numbers above are a stand-in for this.
- **Let the person correct the notes.** They can already see the notebook. Next, let them fix or strike a note in place. That gives precision on real people with no golden set, and builds trust.
- **Saturation as the stopping signal.** The after-call page already plots notes changed per answer. When an area of the notebook stops changing for a few answers, it's done. When the whole notebook does, the session is done.
- **Scaling the notebook.** Past roughly 100k characters, the note-taker would get the tree and summaries only, plus tools to `ls`, `read` and `grep` (a small tool loop, where an agent framework starts to earn its keep). RAG over notes comes after that, for the twin rather than the interviewer.
- **More real people, more sims.** Family members across ages and languages. For simulated people: several seeds per persona, and two different sim models, because sims are known to be more polite and forthcoming than humans.

---

## Appendix: architecture in one paragraph

The browser connects audio straight to OpenAI `gpt-live-1` over WebRTC. The server holds a sideband WebSocket to the same session.
- The voice model leads: it decides when to speak and what to say, guided by the purpose and craft prompt.
- After each person turn, a note-taker (Claude Sonnet via OpenRouter) reads the answer with the person's notebook, writes or edits notes, updates what's still most worth learning, and sends a silent brief to the voice model. After the call, a consolidation pass tidies the whole notebook.
- Text mode uses the same note-taker, which also writes the next question (streamed, so the question shows before the notes finish).
- One `Room` per person runs everything serially, so a person is never driven by two brains at once.
- Storage is pluggable: Postgres, any S3-compatible bucket, files, or D1 on Cloudflare.
- The same code runs as a plain Node server (Dockerfile) or on Cloudflare Workers (`src/worker.ts`: one Durable Object per person).
- The judge model is a different family (Gemini) from the interviewer (Claude) and the simulated people (GPT), to avoid self-preference.
- Text model calls go through the Vercel AI SDK with its OpenRouter provider, which handles retries, streaming, usage accounting and prompt caching. Each prompt puts what never changes first and marks it for caching: the principles (shared by every turn, the opener and the after-call pass), then the reply format. Only the person's context after them is new. In a measured run, the second answer read 2,270 of its 2,817 input tokens from the cache (81%), at a tenth of the price. The hosted turn went from 5.4 s to 3.8 s.
