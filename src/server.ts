import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Store, personId } from './brain/store.ts';
import { PgStore } from './brain/pg-store.ts';
import { S3Store } from './brain/s3-store.ts';
import { usage, MODELS } from './brain/llm.ts';
import { Room, personRow } from './room.ts';
import type { Connect } from './voice/live.ts';

// One Room per person. People and chats go to Postgres (DATABASE_URL) or an S3-compatible bucket
// (S3_BUCKET, e.g. Cloudflare R2), else to files on disk.
const env = process.env;
const files = new Store();
const STORAGE = env.DATABASE_URL ? 'postgres' : env.S3_BUCKET ? 's3' : 'files';
const store =
  STORAGE === 'postgres'
    ? new PgStore(env.DATABASE_URL!)
    : STORAGE === 's3'
      ? new S3Store({ endpoint: env.S3_ENDPOINT ?? '', bucket: env.S3_BUCKET!, accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '', region: env.S3_REGION })
      : { load: async (id: string) => files.get(id), save: (p: Parameters<Store['save']>[0]) => files.save(p), list: async () => files.list().map(personRow) };
const connect: Connect = (url, headers) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 15_000 });
    ws.once('error', reject);
    ws.once('open', () =>
      resolve({
        send: (d) => ws.readyState === WebSocket.OPEN && ws.send(d),
        close: () => ws.close(),
        onMessage: (cb) => ws.on('message', (raw) => cb(raw.toString())),
        onClose: (cb) => ws.on('close', cb),
      }),
    );
    ws.on('error', (e) => console.error('sideband error', e.message));
  });
const rooms = new Map<string, Room>();
const room = (id: string) => {
  let r = rooms.get(id);
  if (!r) rooms.set(id, (r = new Room(id, store, connect)));
  return r;
};
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

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!authed(req)) return json(res, 401, { error: 'passcode required' });
  try {
    const url = new URL(req.url ?? '', 'http://x');
    if (path === '/api/status') return json(res, 200, { models: MODELS, usage });
    if (path === '/api/people') return json(res, 200, { people: (await store.list()).sort((a, b) => b.updatedAt - a.updatedAt) });
    if (path.startsWith('/api/person/')) {
      const r = await room(decodeURIComponent(path.slice('/api/person/'.length))).api('person', {});
      return json(res, r.status, r.body);
    }
    if (path === '/api/lookup') {
      const r = await room(personId(url.searchParams.get('name') ?? '')).api('lookup', {});
      return json(res, r.status, r.body);
    }
    if (req.method === 'POST') {
      const b = await body(req);
      const id = path === '/api/text/start' ? personId(b.name ?? '') : String(b.id ?? '');
      const r = await room(id).api(path.slice('/api/'.length), b);
      return json(res, r.status, r.body);
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
  const file = path === '/' ? 'index.html' : path === '/eval' ? 'eval.html' : path === '/people' ? 'people.html' : normalize(path).replace(/^\/+/, '');
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
  const name = url.searchParams.get('name') ?? '';
  wss.handleUpgrade(req, socket, head, (ws) => {
    const call = room(personId(name)).call(
      (e) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(e)),
      () => ws.close(),
    );
    ws.on('message', (raw) => void call.message(raw.toString()));
    ws.on('close', () => call.close());
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Interviewer on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (brain ${MODELS.brain}, storage ${STORAGE})`);
});
