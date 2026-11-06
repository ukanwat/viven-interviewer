import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as brain from './brain/brain.ts';
import { Store, personId } from './brain/store.ts';
import { startCall, publicPerson, type CallHandle } from './voice/live.ts';
import { sessionReport } from './brain/report.ts';
import { usage, MODELS } from './brain/llm.ts';

const store = new Store();
const PUBLIC = join(import.meta.dirname, '../public');
const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? '127.0.0.1';
// Optional shared passcode for the hosted demo link (keeps strangers from spending the keys).
const PASSCODE = process.env.PASSCODE ?? '';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 200_000) throw new Error('Body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function authed(req: IncomingMessage) {
  if (!PASSCODE) return true;
  const url = new URL(req.url ?? '/', 'http://x');
  return req.headers['x-passcode'] === PASSCODE || url.searchParams.get('code') === PASSCODE;
}

// One person can't be driven by two brains at once.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}

function getOrCreate(name: string, topic: string, golden?: string[]) {
  const id = personId(name);
  let p = store.get(id);
  if (!p) p = brain.newPerson(name, topic);
  else if (topic && !p.topicHint) p.topicHint = topic;
  if (golden?.length) p.sealedGolden = golden;
  return p;
}

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!authed(req)) return json(res, 401, { error: 'passcode required' });
  try {
    if (req.method === 'GET' && path.startsWith('/api/person/')) {
      const p = store.get(decodeURIComponent(path.slice('/api/person/'.length)));
      return p ? json(res, 200, publicPerson(p)) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && path === '/api/lookup') {
      const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
      const p = store.get(personId(name));
      return json(res, 200, p ? { returning: brain.isReturning(p), person: publicPerson(p) } : { returning: false });
    }
    if (req.method === 'GET' && path === '/api/status') {
      return json(res, 200, { models: MODELS, usage });
    }
    if (req.method === 'POST' && path === '/api/text/start') {
      const b = await body(req);
      if (!b.name?.trim()) return json(res, 400, { error: 'name required' });
      const id = personId(b.name);
      return await withLock(id, async () => {
        const p = getOrCreate(b.name, b.topic ?? '', b.golden);
        const s = brain.startSession(p, 'text');
        const d = await brain.opener(p, s.id, 'text');
        store.save(p);
        json(res, 200, { sessionId: s.id, decision: d, person: publicPerson(p) });
      });
    }
    if (req.method === 'POST' && path === '/api/text/turn') {
      const b = await body(req);
      const text = String(b.text ?? '').slice(0, 4000);
      if (!text.trim()) return json(res, 400, { error: 'empty' });
      return await withLock(b.id, async () => {
        const p = store.get(b.id);
        if (!p) return json(res, 404, { error: 'not found' });
        const t0 = Date.now();
        const d = await brain.personTurn(p, text, 'text', b.sessionId);
        if (d.move === 'wrap') brain.endSession(p, b.sessionId, 'later');
        store.save(p);
        json(res, 200, { decision: d, ms: Date.now() - t0, person: publicPerson(p) });
        if (p.turns.filter((t) => t.role === 'person').length % 4 === 0) {
          void withLock(p.id, async () => {
            const q = store.get(p.id)!;
            await brain.refreshSummary(q);
            store.save(q);
          }).catch(() => {});
        }
      });
    }
    if (req.method === 'POST' && path === '/api/text/end') {
      const b = await body(req);
      return await withLock(b.id, async () => {
        const p = store.get(b.id);
        if (!p) return json(res, 404, { error: 'not found' });
        brain.endSession(p, b.sessionId, b.reason ?? 'later');
        await brain.refreshSummary(p).catch(() => {});
        store.save(p);
        json(res, 200, { person: publicPerson(p) });
      });
    }
    if (req.method === 'POST' && path === '/api/report') {
      const b = await body(req);
      return await withLock(b.id, async () => {
        const p = store.get(b.id);
        if (!p) return json(res, 404, { error: 'not found' });
        const r = await sessionReport(p, b.sessionId);
        p.reports = [...(p.reports ?? []).filter((x) => x.sessionId !== (b.sessionId ?? 'all')), { sessionId: b.sessionId ?? 'all', at: Date.now(), report: r }];
        store.save(p);
        json(res, 200, { report: r });
      });
    }
    json(res, 404, { error: 'unknown route' });
  } catch (e) {
    console.error('api error', path, (e as Error).message);
    json(res, 500, { error: 'Something went wrong on the server. Try again.' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  if (path.startsWith('/api/')) return api(req, res, path);
  const file = path === '/' ? 'index.html' : path === '/eval' ? 'eval.html' : normalize(path).replace(/^\/+/, '');
  if (file.includes('..')) return res.writeHead(400).end();
  try {
    const content = await readFile(join(PUBLIC, file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(content);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

// Voice calls: one WebSocket per call between the browser and this server.
const wss = new WebSocketServer({ noServer: true, maxPayload: 256_000 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws' || !authed(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleCall(ws));
});

function handleCall(ws: WebSocket) {
  let handle: CallHandle | undefined;
  const notify = (e: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
  };
  ws.on('message', async (raw) => {
    let m: any;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.type === 'start' && !handle) {
      if (!m.name?.trim() || !m.sdp) return notify({ type: 'error', message: 'name and offer required' });
      try {
        const p = getOrCreate(m.name, m.topic ?? '', m.golden);
        const call = await startCall({ store, person: p, offerSdp: m.sdp, notify });
        handle = call.handle;
        notify({ type: 'answer', sdp: call.answerSdp, sessionId: call.sessionId, personId: p.id });
      } catch (e) {
        console.error('call start failed', (e as Error).message);
        notify({ type: 'error', message: (e as Error).message });
        ws.close();
      }
    } else if (m.type === 'hangup') {
      await handle?.hangup(m.reason ?? 'later');
    } else if (m.type === 'typed' && typeof m.text === 'string') {
      handle?.typed(m.text.slice(0, 4000));
    }
  });
  ws.on('close', () => void handle?.hangup('browser_closed'));
}

server.listen(PORT, HOST, () => {
  console.log(`Interviewer on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (brain ${MODELS.brain})`);
});
