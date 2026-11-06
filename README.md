# Viven interviewer

A voice-first interviewer that gets to know a whole person (how they decide, what they put first, what they notice, how they talk) and keeps it as a notebook a digital twin could use.

- **Live:** https://viven-interviewer.utkarshkanwat.com (needs a passcode; ask me for it)
- **The thinking:** [THINKING.md](THINKING.md) is the experiment log: hypotheses, what broke, what changed and the evidence. Start there.
- **Eval:** `/eval` on the site shows the simulated-people results with full transcripts.

## Using it

1. Type your name. Optionally add a link about yourself (it's only used to ask better questions, never stored as fact).
2. Press **Start talking** (voice) or **or type instead** (text). Same interviewer, same memory.
3. Talk. The notebook beside the conversation fills in as you go; new and changed notes are tagged.
4. Press **End call**, or just say "call me later". You get your notebook (downloadable as markdown) and a short review of the conversation. Come back with the same name and it picks up where you left off.

Other pages: `/people.html` lists everyone with their notebook and past conversations. `/eval.html` shows the eval. Add `?lab` to the start page for lab fields (sealed facts used in evals).

## How it works

```
browser ──WebRTC audio──▶ OpenAI gpt-live-1 (speaks, owns turn-taking)
   │                              ▲
   │ text / events                │ sideband WS: transcripts in, silent briefs out
   ▼                              │
Room (one per person, serial) ── brain: note-taker (Claude Sonnet via OpenRouter)
   │                                 reads the answer + notebook → note ops + what's still worth learning
   ▼
store: files | Postgres | S3/R2 | D1
```

- **Voice:** the realtime model leads the conversation, guided by the craft prompt (`src/brain/prompts.ts`). After each answer, the note-taker updates the notebook and slips the voice model a silent brief: what was just noted and what's still most worth learning.
- **Text:** the same note-taker also writes the next question, streamed so the question appears before the notes finish.
- **Memory** (`src/brain/notes.ts`): a folder tree of markdown notes, any depth, each with a title and one-line summary; folders carry descriptions. Per turn the model returns `write / move / delete / folder` ops. After each call a consolidation pass tidies the whole tree. Rules: notes are about the person, never the conversation; their words where wording matters; never lose a detail on rewrite.
- **Report** (`src/brain/report.ts`): after a call, a judge from a different model family (Gemini) reviews the conversation: what it learned, what to ask next time, interviewer mistakes.
- **Connectors** (`src/brain/mcp.ts`, `sources.ts`): optional. A person can connect Notion, Granola, Linear, Jira/Confluence, ClickUp or Airtable (remote MCP; OAuth with dynamic registration + PKCE). A Haiku agent with read-only tools writes a separate "from your tools" notebook. The interviewer uses it to ask the why, never as their words. The person can strike notes, and it re-reads after a day.
- **Eval** (`eval/run.ts`): simulated people (GPT) with hidden facts talk to the real text channel; a judge from another family grades any conversation, simulated or real. See THINKING.md §6, §11 and eval/FINDINGS-2026-11-07.md.

| Role | Model |
|---|---|
| Voice | `gpt-live-1` (OpenAI Realtime) |
| Note-taker / interviewer brain | `anthropic/claude-sonnet-5.5` |
| Fast tasks (link summary, running summary) | `anthropic/claude-haiku-5.5` |
| Simulated people (eval) | `openai/gpt-6-luna` |
| Judge (report, eval) | `google/gemini-4-argon` (report); `deepseek/deepseek-v4.1-flash` (eval, falls back to `google/gemini-3.8-flash`) |

All text models go through OpenRouter via the Vercel AI SDK (`src/brain/llm.ts`), with prompt caching. The stable prefix (principles, reply format) is marked once and reused by every turn and by the after-call pass; about 80% of a turn's input is read from cache. Set `LLM_LOG=1` to log tokens, cache hits and cost per call. The OpenAI key is used only for voice.

## Running it

Node ≥ 22.18 (runs TypeScript directly, no build step).

```sh
pnpm install
export OPENROUTER_API_KEY=...   # text models
export OPENAI_API_KEY=...       # voice
export PASSCODE=...             # optional: gate the API
pnpm dev                        # http://localhost:8000
```

Storage is picked from the environment: `DATABASE_URL` → Postgres, `S3_BUCKET` (+ `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`) → any S3-compatible bucket, otherwise JSON files in `DATA_DIR` (default `data/people`). Models can be overridden with `BRAIN_MODEL`, `FAST_MODEL`, `JUDGE_MODEL`, `PERSONA_MODEL`, `VOICE_MODEL`.

**Docker:** `docker build -t viven . && docker run -p 8000:8000 -e OPENROUTER_API_KEY -e OPENAI_API_KEY viven`

**Cloudflare (how the live site runs):** `src/worker.ts` runs the same Room inside one Durable Object per person, with D1 for storage. Set secrets with `wrangler secret put OPENROUTER_API_KEY` (and `OPENAI_API_KEY`, `PASSCODE`), create the D1 database named in `wrangler.jsonc`, then `pnpm run deploy`.

**Eval** (`eval/run.ts`, modules in `eval/lib/`): `sim` (simulated people talk to the real text channel, with a "call me later" break), `show` (read one with the interviewer's live read of each answer and its gaps file), `grade` (any conversation: saved sims, `--local` people, or `--hosted` ones from the site; real ones need no gold answers: coverage = outsider questions answered from the notes, checked against everything they said), `compare A B` (paired by person, cluster-bootstrap CIs; verdict = primary metric better and no guard worse), `meta` (how far to trust it: judge vs hand labels, retest flips, seed noise and smallest detectable change, sims vs real people, coverage vs gold twin), `view` (a static HTML page per graded set that doubles as the review queue: pass/fail each conversation with a note on its first failure, click a judge label to correct it, download labels; `review-import` turns them into the calibration set `meta` checks the judge against, as TPR/TNR per label), `improve` (failure digest → one proposed prompt edit to A/B; reads only the dev people in `eval/scenarios/splits.json`, and `compare` reports the held-out people on their own line). Every run and graded set records what made it (commit, hashes of the interviewer, judge, sim and personas, models), and `compare` warns when anything but the interviewer differs. `triage` counts failure types from the #tags in your review notes next to what the judge flags (Hamel's error analysis); `pull` fetches new hosted conversations into a local review queue (free; grading them is a separate, paid step; real people's data is gitignored). Ten simulated people (talkative, terse, Hinglish, hostile-then-warm, busy exec, low-effort student, concrete tradesman, people-pleaser, slow-to-trust farmer, a lawyer who won't discuss clients), split five dev / five held-out. `npm run test:eval` runs the harness's own tests (no model calls; also in CI). Reports show pass^k (all k tries with the same person stay, stay calm, invent nothing) when there are several seeds. Judge calls are cached on disk, so re-grading is free. `BRAIN_MODEL=anthropic/claude-haiku-5.5` for cheap runs (about $0.015 per person). Latest read-through: eval/FINDINGS-2026-11-07.md.

**Typecheck:** `pnpm typecheck` (Node and Worker configs).

## Layout

```
src/
  server.ts        Node server: static files, API, voice sideband
  worker.ts        Cloudflare Worker + Durable Object
  room.ts          one person's room: text turns, end of call, report, notes rebuild
  brain/           prompts, note-taker, notebook ops, report, model client, stores
  voice/live.ts    realtime session: transcripts in, briefs out, end-of-call
public/            start / call / after views, people, eval
eval/              harness, personas with hidden facts, results
THINKING.md        the experiment log
```
