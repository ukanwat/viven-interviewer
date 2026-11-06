// All text LLM calls go through OpenRouter, via the AI SDK (retries, streaming, usage, prompt caching).
// Voice (gpt-live-1) is the only OpenAI-direct path.
import { generateText, streamText, type LanguageModelUsage, type ModelMessage, type SystemModelMessage } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

export const MODELS = {
  // The interviewer brain: analysis + planning each turn. Needs judgement and speed.
  brain: process.env.BRAIN_MODEL ?? 'anthropic/claude-sonnet-5.5',
  // Cheap, fast pass for the live "what I've learned" extraction.
  fast: process.env.FAST_MODEL ?? 'anthropic/claude-haiku-5.5',
  // Simulated interviewees. Different family from the brain.
  persona: process.env.PERSONA_MODEL ?? 'openai/gpt-6-luna',
  // Eval judge. Different family from both (self-preference bias).
  judge: process.env.JUDGE_MODEL ?? 'google/gemini-4-argon',
};

// A message, or parts of one, can be marked `cache`: a prompt-cache breakpoint at its end. Put what
// doesn't change between calls first and mark it; Anthropic caches the prefix up to the mark for
// 5 minutes (reads cost a tenth). OpenAI and Google models cache prefixes on their own.
export type Part = { text: string; cache?: boolean };
export type Msg = { role: 'system' | 'user' | 'assistant'; content: string | Part[]; cache?: boolean };

export type Usage = { calls: number; costUsd: number; promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export const usage: Usage = { calls: 0, costUsd: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

type CallOpts = { model: string; temperature?: number; maxTokens?: number; json?: boolean; seed?: number; signal?: AbortSignal };

const CACHE = { openrouter: { cacheControl: { type: 'ephemeral' } } } as const;

let provider: ReturnType<typeof createOpenRouter> | undefined;
let providerKey = '';
function model(opts: CallOpts) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  if (!provider || providerKey !== key) (provider = createOpenRouter({ apiKey: key, headers: { 'X-Title': 'viven-interviewer' } })), (providerKey = key);
  return provider(opts.model, {
    usage: { include: true },
    ...(opts.json ? { extraBody: { response_format: { type: 'json_object' } } } : {}),
  });
}

function toModelMessages(messages: Msg[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    const parts: Part[] = typeof m.content === 'string' ? [{ text: m.content, cache: m.cache }] : m.content;
    if (m.role === 'system') {
      // A system message is one string; a breakpoint on it covers the whole of it.
      const cache = m.cache || parts.some((x) => x.cache);
      return { role: 'system', content: parts.map((x) => x.text).join('\n\n'), ...(cache ? { providerOptions: CACHE } : {}) };
    }
    return {
      role: m.role,
      content: parts.map((x) => ({ type: 'text' as const, text: x.text, ...(x.cache ? { providerOptions: CACHE } : {}) })),
    } as ModelMessage;
  });
}

function settings(messages: Msg[], opts: CallOpts) {
  const all = toModelMessages(messages);
  const instructions = all.filter((m): m is SystemModelMessage => m.role === 'system');
  return {
    model: model(opts),
    // The SDK takes system prompts as `instructions`; as messages they keep their cache mark.
    ...(instructions.length ? { instructions } : {}),
    messages: all.filter((m) => m.role !== 'system'),
    temperature: opts.temperature ?? 0.4,
    maxOutputTokens: opts.maxTokens ?? 1500,
    seed: opts.seed,
    abortSignal: opts.signal,
    maxRetries: 2,
  };
}

function track(model: string, u: LanguageModelUsage | undefined, meta: any) {
  if (process.env.LLM_LOG) console.log(`llm ${model} in ${u?.inputTokens ?? 0} (cache read ${u?.inputTokenDetails?.cacheReadTokens ?? 0}, write ${u?.inputTokenDetails?.cacheWriteTokens ?? 0}) out ${u?.outputTokens ?? 0} $${(meta?.openrouter?.usage?.cost ?? 0).toFixed(4)}`);
  usage.calls++;
  usage.costUsd += meta?.openrouter?.usage?.cost ?? 0;
  usage.promptTokens += u?.inputTokens ?? 0;
  usage.completionTokens += u?.outputTokens ?? 0;
  usage.cacheReadTokens += u?.inputTokenDetails?.cacheReadTokens ?? 0;
  usage.cacheWriteTokens += u?.inputTokenDetails?.cacheWriteTokens ?? 0;
}

export async function chat(messages: Msg[], opts: CallOpts): Promise<string> {
  const r = await generateText(settings(messages, opts));
  track(opts.model, r.usage, r.providerMetadata);
  return r.text;
}

// Streaming variant: onText gets the full text so far after each chunk (lets callers act on
// the first complete JSON field before the rest arrives).
export async function chatStream(messages: Msg[], opts: CallOpts & { onText?: (soFar: string) => void }): Promise<string> {
  let error: unknown;
  const r = streamText({ ...settings(messages, opts), onError: ({ error: e }) => void (error = e) });
  let text = '';
  for await (const d of r.textStream) {
    text += d;
    opts.onText?.(text);
  }
  if (error) throw error;
  track(opts.model, await r.usage, await r.providerMetadata);
  return text;
}

// Pull a complete JSON object value for `key` out of partial JSON text, if it's finished.
export function completedObject(text: string, key: string): any | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*\\{`).exec(text);
  if (!m) return undefined;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(i, j + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export async function chatJson<T>(messages: Msg[], opts: CallOpts): Promise<T> {
  const text = await chat(messages, { ...opts, json: true });
  return parseJson<T>(text);
}

export function parseJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error(`Model did not return JSON: ${cleaned.slice(0, 200)}`);
  }
}
