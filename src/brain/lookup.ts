// Background from a link the person gave (their site, a profile, an article). Used only to ask
// better questions; it is not something they said, so it never becomes a captured item.
import { chat, MODELS } from './llm.ts';
import type { Person } from './types.ts';

function allowed(raw: string): URL | undefined {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(u.protocol)) return undefined;
    // Public web only.
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(u.hostname) || !u.hostname.includes('.')) return undefined;
    return u;
  } catch {
    return undefined;
  }
}

function pageText(html: string) {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '';
  const metas = [...html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:description|og:title)["'][^>]*content=["']([^"']*)["']/gi)].map((m) => m[1]);
  const body = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  return [title, ...metas, body].join('\n').slice(0, 15_000);
}

export async function lookUp(p: Person, link: string): Promise<void> {
  const u = allowed(link.trim());
  if (!u) return;
  if (p.background?.url === u.href) return;
  let text = '';
  try {
    const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (interviewer background lookup)', Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(7000) });
    if (res.ok) text = pageText((await res.text()).slice(0, 1_000_000));
  } catch {}
  let brief = '';
  if (text.trim().length > 80) {
    brief = (
      await chat(
        [
          { role: 'system', content: 'You write short, factual background notes for someone about to have a conversation. Use only what the page says.' },
          {
            role: 'user',
            content: `Page from ${u.href}:\n"""\n${text}\n"""\n\nWrite a background note (max 100 words) about ${p.name}: what they do, where, what they seem to care about or be known for. Only what this page shows. If the page isn't about ${p.name}, or has nothing useful (login wall, blocked), reply exactly NONE.`,
          },
        ],
        { model: MODELS.fast, temperature: 0.1, maxTokens: 400 },
      ).catch(() => '')
    ).trim();
  }
  p.background = { url: u.href, brief: brief && brief !== 'NONE' ? brief : '', at: Date.now() };
}
