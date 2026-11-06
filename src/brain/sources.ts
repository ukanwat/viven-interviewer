// Tools a person chose to connect (MCP). An agent reads them the way a new colleague would catch
// up, and keeps a separate notebook of what it found. That notebook is context for the interviewer,
// never something the person said: it points the interview at the why behind what the tools show.
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import { runAgent, MODELS } from './llm.ts';
import { McpClient, PRESETS, beginAuth, finishAuth, refreshTokens, isReadTool, randomToken, serverUrl } from './mcp.ts';
import { SOURCES_PROMPT } from './prompts.ts';
import type { Connection, Person, SourceNote } from './types.ts';

const MAX_STEPS = 24;
const MAX_RESULT = 6000;
export const STALE_MS = 24 * 3600_000; // re-read on a later visit after this long

const cleanPath = (s: string) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9/\-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, 120);

// Step 1 of connecting: find the server's sign-in, register, and remember what the callback needs.
export async function startConnect(p: Person, server: string, redirectUri: string): Promise<string> {
  const preset = PRESETS.find((x) => x.id === server);
  const u = serverUrl(preset?.url ?? server);
  if (!u) throw new Error('That does not look like an MCP server address (https://…).');
  const id = preset?.id ?? u.hostname;
  const state = `${p.id}.${randomToken(18)}`;
  const { url, verifier, oauth } = await beginAuth(u, redirectUri, state);
  p.connections = (p.connections ?? []).filter((c) => c.id !== id);
  p.connections.push({ id, label: preset?.label ?? u.hostname, url: u.href, status: 'pending', oauth, pending: { state, verifier, redirectUri, at: Date.now() } });
  return url;
}

// Step 2: the redirect came back. Swap the code for tokens; the caller then runs read().
export async function finishConnect(p: Person, state: string, code: string): Promise<Connection> {
  const c = p.connections?.find((x) => x.pending?.state === state);
  if (!c?.oauth || !c.pending) throw new Error('This sign-in link has expired. Try connecting again.');
  if (Date.now() - c.pending.at > 15 * 60_000) throw new Error('This sign-in took too long. Try connecting again.');
  c.tokens = await finishAuth(c.oauth, code, c.pending.verifier, c.pending.redirectUri);
  c.pending = undefined;
  c.status = 'reading';
  c.connectedAt = Date.now();
  return c;
}

export function disconnect(p: Person, id: string) {
  p.connections = (p.connections ?? []).filter((c) => c.id !== id);
  for (const [k, n] of Object.entries(p.sources ?? {})) if (n.from === id) delete p.sources![k];
}

export function strike(p: Person, path: string) {
  if (p.sources) delete p.sources[path];
}

async function client(c: Connection): Promise<McpClient> {
  if (!c.tokens) throw new Error('not connected');
  if (c.tokens.expiresAt && c.tokens.expiresAt < Date.now() + 60_000 && c.tokens.refresh && c.oauth) c.tokens = await refreshTokens(c.oauth, c.tokens.refresh);
  let m = new McpClient(c.url, c.tokens.access);
  try {
    await m.connect();
  } catch (e) {
    if ((e as Error).message !== 'unauthorized' || !c.tokens.refresh || !c.oauth) throw e;
    c.tokens = await refreshTokens(c.oauth, c.tokens.refresh);
    m = new McpClient(c.url, c.tokens.access);
    await m.connect();
  }
  return m;
}

function sourcesOf(p: Person, from: string) {
  return Object.values(p.sources ?? {}).filter((n) => n.from === from);
}

// The agent: read-only tools from the server, plus a pen for its own notes. It decides what to open.
export async function read(p: Person, c: Connection, opts: { signal?: AbortSignal; onChange?: () => void } = {}): Promise<void> {
  c.status = 'reading';
  c.error = undefined;
  try {
    const m = await client(c);
    const all = await m.tools();
    const readable = all.filter(isReadTool);
    if (!readable.length) throw new Error('This server has no read-only tools to look through.');
    p.sources ??= {};
    let calls = 0;
    const tools: ToolSet = {};
    for (const t of readable.slice(0, 40))
      tools[t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)] = dynamicTool({
        description: (t.description ?? t.name).slice(0, 1000),
        inputSchema: jsonSchema(t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }),
        execute: async (args) => {
          calls++;
          try {
            const out = await m.call(t.name, args);
            return out.length > MAX_RESULT ? `${out.slice(0, MAX_RESULT)}\n…[cut: ${out.length - MAX_RESULT} more characters]` : out;
          } catch (e) {
            return `Error: ${(e as Error).message}`;
          }
        },
      });
    tools.write_note = dynamicTool({
      description: 'Write or replace one note in your notebook about this person (the whole note).',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'lowercase-kebab folders with "/", e.g. "work/agent-platform"' },
          title: { type: 'string' },
          summary: { type: 'string', description: 'one line' },
          body: { type: 'string', description: 'a few short lines or bullets; say where you saw it (page or issue title, date)' },
        },
        required: ['path', 'title', 'summary', 'body'],
      }),
      execute: async (a: any) => {
        const path = cleanPath(a.path);
        if (!path) return 'Error: empty path';
        const prev = p.sources![path];
        if (prev && prev.from !== c.id) return `Error: ${path} belongs to another source; pick another path`;
        p.sources![path] = { path, title: String(a.title ?? path).slice(0, 120), summary: String(a.summary ?? '').slice(0, 300), body: String(a.body ?? '').slice(0, 2000), from: c.id, updatedAt: Date.now() };
        opts.onChange?.();
        return `saved ${path}`;
      },
    });
    tools.delete_note = dynamicTool({
      description: 'Delete one of your notes that is no longer true.',
      inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
      execute: async (a: any) => {
        const path = cleanPath(a.path);
        if (p.sources![path]?.from !== c.id) return 'Error: no such note of yours';
        delete p.sources![path];
        opts.onChange?.();
        return `deleted ${path}`;
      },
    });

    const preset = PRESETS.find((x) => x.id === c.id);
    const mine = sourcesOf(p, c.id);
    const prompt = [
      `Person: ${p.name}${p.expertise ? ` (${p.expertise})` : ''}. Today: ${new Date().toISOString().slice(0, 10)}.`,
      `Connected tool: ${c.label}${preset ? ` (${preset.what})` : ''}.`,
      c.lastRead ? `You last read it on ${new Date(c.lastRead).toISOString().slice(0, 10)}. Catch up on what's new or changed since then and update your notes.` : 'This is your first read.',
      mine.length ? `Your notes so far:\n${mine.map((n) => `- ${n.path}: ${n.title}. ${n.summary}\n  ${n.body.replace(/\n/g, '\n  ')}`).join('\n')}` : 'You have no notes yet.',
      `You have about ${MAX_STEPS - 2} tool calls. End with one short paragraph: what you now understand about what they do.`,
    ].join('\n\n');
    const summary = await runAgent({ model: MODELS.fast, system: SOURCES_PROMPT, prompt, tools, maxSteps: MAX_STEPS, signal: opts.signal });
    c.summary = summary.trim().slice(0, 1200) || c.summary;
    c.lastRead = Date.now();
    c.status = 'ready';
    if (!calls) c.error = 'The agent did not open anything this time.';
  } catch (e) {
    c.status = c.lastRead ? 'ready' : 'failed';
    c.error = (e as Error).message.slice(0, 200);
  }
  opts.onChange?.();
}

// For the interviewer: what the tools show, clearly marked as not said by them.
export function renderSources(p: Person, max = 5000): string {
  const notes = Object.values(p.sources ?? {}).sort((a, b) => a.path.localeCompare(b.path));
  if (!notes.length) return '';
  const label = (id: string) => p.connections?.find((c) => c.id === id)?.label ?? id;
  let out = '';
  for (const n of notes) {
    const line = `- [${label(n.from)}] ${n.title}: ${n.summary}\n  ${n.body.replace(/\n/g, '\n  ')}\n`;
    if (out.length + line.length > max) break;
    out += line;
  }
  return out.trim();
}

export const connectedLabels = (p: Person) => (p.connections ?? []).filter((c) => c.status === 'ready' || c.status === 'reading').map((c) => c.label);

export function publicConnections(p: Person) {
  return (p.connections ?? []).map(({ id, label, status, error, connectedAt, lastRead, summary }) => ({ id, label, status, error, connectedAt, lastRead, summary }));
}

export function publicSources(p: Person): SourceNote[] {
  return Object.values(p.sources ?? {});
}
