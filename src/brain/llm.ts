// All text LLM calls go through OpenRouter. Voice (gpt-live-1) is the only OpenAI-direct path.

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

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export type Usage = { calls: number; costUsd: number; promptTokens: number; completionTokens: number };
export const usage: Usage = { calls: 0, costUsd: 0, promptTokens: 0, completionTokens: 0 };

type CallOpts = { model: string; temperature?: number; maxTokens?: number; json?: boolean; seed?: number; signal?: AbortSignal };

export async function chat(messages: Msg[], opts: CallOpts): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: opts.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'X-Title': 'viven-interviewer',
        },
        body: JSON.stringify({
          model: opts.model,
          messages,
          temperature: opts.temperature ?? 0.4,
          max_tokens: opts.maxTokens ?? 1500,
          seed: opts.seed,
          usage: { include: true },
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`OpenRouter HTTP ${res.status}`);
      const data: any = await res.json();
      if (data.error) throw new Error(`OpenRouter: ${data.error.message ?? JSON.stringify(data.error)}`);
      usage.calls++;
      usage.costUsd += data.usage?.cost ?? 0;
      usage.promptTokens += data.usage?.prompt_tokens ?? 0;
      usage.completionTokens += data.usage?.completion_tokens ?? 0;
      const text: string = data.choices?.[0]?.message?.content ?? '';
      return text;
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Streaming variant: onText gets the full text so far after each chunk (lets callers act on
// the first complete JSON field before the rest arrives).
export async function chatStream(messages: Msg[], opts: CallOpts & { onText?: (soFar: string) => void }): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: opts.signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'viven-interviewer' },
    body: JSON.stringify({
      model: opts.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1500,
      seed: opts.seed,
      stream: true,
      usage: { include: true },
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`OpenRouter HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        if (j.error) throw new Error(`OpenRouter: ${j.error.message ?? 'stream error'}`);
        const d = j.choices?.[0]?.delta?.content;
        if (d) {
          text += d;
          opts.onText?.(text);
        }
        if (j.usage) {
          usage.calls++;
          usage.costUsd += j.usage.cost ?? 0;
          usage.promptTokens += j.usage.prompt_tokens ?? 0;
          usage.completionTokens += j.usage.completion_tokens ?? 0;
        }
      } catch (e) {
        if ((e as Error).message.startsWith('OpenRouter')) throw e;
      }
    }
  }
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
