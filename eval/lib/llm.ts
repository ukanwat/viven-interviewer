// Model calls for the harness: the judge, twin and simulated people. Every call is cached on disk by
// its exact input, so re-grading a saved conversation with an unchanged judge costs nothing, and a
// changed judge prompt only pays for itself. NO_CACHE=1 bypasses it (e.g. to measure judge retest).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatJson, usage, type Msg } from '../../src/brain/llm.ts';

export const JUDGE = process.env.EVAL_JUDGE ?? 'deepseek/deepseek-v4.1-flash';
export const JUDGE_FALLBACK = 'google/gemini-3.8-flash';
export const TWIN = process.env.EVAL_TWIN ?? 'openai/gpt-6-luna';
export const SIM = process.env.PERSONA_MODEL ?? 'openai/gpt-6-luna';

const DIR = join(import.meta.dirname, '../results/cache');
const NO_CACHE = !!process.env.NO_CACHE;
export const cacheStats = { hits: 0, misses: 0 };
// Which model actually answered (by model id), so a run that fell back to the second judge says so.
export const answeredBy: Record<string, number> = {};

type Opts = { model: string; temperature?: number; maxTokens?: number; seed?: number; tag?: string };

// One JSON call: cached, one retry, and the judge's retry goes to a steadier model.
export async function askJson<T>(msgs: Msg[], opts: Opts): Promise<T> {
  const { tag, ...call } = opts;
  const key = createHash('sha256').update(JSON.stringify({ msgs, call, tag })).digest('hex').slice(0, 32);
  const file = join(DIR, `${key}.json`);
  if (!NO_CACHE && existsSync(file)) {
    cacheStats.hits++;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  }
  cacheStats.misses++;
  for (let i = 0; ; i++) {
    try {
      const model = i && call.model === JUDGE ? JUDGE_FALLBACK : call.model;
      const out = await chatJson<T>(msgs, { ...call, model });
      answeredBy[model] = (answeredBy[model] ?? 0) + 1;
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, JSON.stringify(out));
      return out;
    } catch (e) {
      if (i >= 1) throw new Error(`${call.model}: ${(e as Error).message.slice(0, 300)}`);
    }
  }
}

export const spent = () => usage.costUsd;
