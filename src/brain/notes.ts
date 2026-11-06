// Memory: a folder tree of short markdown notes per person, written and organised by the model.
// One person's notes fit in context (tree + summaries, bodies up to a budget), so the model sees
// everything and opens what it needs; no retrieval index. Code only applies the edits it asks for.
import { chatJson, MODELS } from './llm.ts';
import { MEMORY_RULES, NOTE_OPS_SCHEMA, PURPOSE } from './prompts.ts';
import type { Note, NoteChange, NoteOp, Person, Turn } from './types.ts';

const BODY_BUDGET = 14_000; // chars of note bodies shown in context; beyond this, summaries only

export function notesOf(p: Person): Record<string, Note> {
  return (p.notes ??= {});
}

const cleanPath = (s: string) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\.md$/, '')
    .split('/')
    .map((x) => x.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('/');

// The tree as the model sees it: every path with its summary; full bodies for the most recently
// touched notes up to the budget. Notes without a body shown are marked so the model won't overwrite them blind.
export function renderNotes(p: Person): string {
  const notes = Object.values(notesOf(p));
  if (!notes.length) return '(no notes yet)';
  const byRecent = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
  const withBody = new Set<string>();
  let used = 0;
  for (const n of byRecent) {
    if (used + n.body.length > BODY_BUDGET) break;
    used += n.body.length;
    withBody.add(n.path);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const n of [...notes].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const dir of dirsOf(n.path)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      lines.push(`## ${dir}/ — ${p.folders?.[dir] ?? '(no description yet)'}`, '');
    }
    lines.push(`### ${n.path} — ${n.title}\nsummary: ${n.summary}`);
    lines.push(withBody.has(n.path) ? n.body.trim() : '(body not shown: to change this note, only move or delete it)');
    lines.push('');
  }
  return lines.join('\n').trim();
}

// Just the tree, for places that need it short (the voice model's context).
export function renderTree(p: Person): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const n of Object.values(notesOf(p)).sort((a, b) => a.path.localeCompare(b.path))) {
    for (const dir of dirsOf(n.path))
      if (!seen.has(dir)) {
        seen.add(dir);
        if (p.folders?.[dir]) lines.push(`- ${dir}/: ${p.folders[dir]}`);
      }
    lines.push(`- ${n.path}: ${n.summary}`);
  }
  return lines.join('\n');
}

// "a/b/c" -> ["a", "a/b"]
function dirsOf(path: string) {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

// Drop descriptions of folders that no longer hold any note.
function pruneFolders(p: Person) {
  if (!p.folders) return;
  const live = new Set(Object.keys(notesOf(p)).flatMap(dirsOf));
  for (const f of Object.keys(p.folders)) if (!live.has(f)) delete p.folders[f];
}

export function applyNoteOps(p: Person, ops: NoteOp[] | undefined, src: { turnId?: string; sessionId: string }): NoteChange[] {
  const notes = notesOf(p);
  const changes: NoteChange[] = [];
  const now = Date.now();
  for (const op of ops ?? []) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'write') {
      const path = cleanPath(op.path);
      if (!path || !op.body?.trim()) continue;
      const prev = notes[path];
      notes[path] = {
        path,
        title: (op.title || prev?.title || path.split('/').pop()!).slice(0, 100),
        summary: (op.summary || prev?.summary || '').slice(0, 240),
        body: op.body.trim().slice(0, 4000),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        sessions: [...new Set([...(prev?.sessions ?? []), src.sessionId])],
        turns: src.turnId ? [...new Set([...(prev?.turns ?? []), src.turnId])] : (prev?.turns ?? []),
      };
      changes.push({ op: prev ? 'edit' : 'add', path, title: notes[path].title, summary: notes[path].summary });
    } else if (op.op === 'move') {
      const from = cleanPath(op.from);
      const to = cleanPath(op.to);
      if (!notes[from] || !to || from === to) continue;
      const n = notes[from];
      delete notes[from];
      if (notes[to]) {
        // Moving onto an existing note: keep both, appended.
        notes[to] = { ...notes[to], body: `${notes[to].body}\n\n${n.body}`, updatedAt: now, turns: [...new Set([...notes[to].turns, ...n.turns])] };
      } else notes[to] = { ...n, path: to, updatedAt: now };
      changes.push({ op: 'move', path: to, from, title: notes[to].title, summary: notes[to].summary });
    } else if (op.op === 'folder') {
      const path = cleanPath(op.path);
      if (path && op.description) (p.folders ??= {})[path] = String(op.description).slice(0, 200);
    } else if (op.op === 'delete') {
      const path = cleanPath(op.path);
      if (!notes[path]) continue;
      changes.push({ op: 'delete', path, title: notes[path].title, summary: notes[path].summary });
      delete notes[path];
    }
  }
  pruneFolders(p);
  return changes;
}

// After a call (or to rebuild an old record from its transcript): read the whole tree against what
// they said and tidy it: merge, correct, drop what isn't about them, reorganise.
export async function consolidate(p: Person, opts: { sessionId: string; turns?: Turn[]; signal?: AbortSignal; fromScratch?: boolean }) {
  const turns = opts.turns ?? p.turns.filter((t) => t.sessionId === opts.sessionId);
  if (!turns.some((t) => t.role === 'person')) return [];
  const transcript = turns.map((t) => `${t.role === 'agent' ? 'Interviewer' : p.name}: ${t.text}`).join('\n');
  const task = opts.fromScratch
    ? `Write ${p.name}'s notes from scratch from this transcript.`
    : `This conversation just ended. Tidy ${p.name}'s notes against it: add anything they said that's missing, fix any note their words don't support, remove anything that isn't about them (conversation logistics, the interviewer's guesses), merge duplicates and overlaps, and reorganise folders if a clearer structure is now visible. If the notes are already right, return no ops.`;
  const out = await chatJson<{ notes?: NoteOp[]; open?: string[]; who?: string }>(
    [
      { role: 'system', content: `You keep the notes of an interviewer. ${PURPOSE}\n\n${MEMORY_RULES}` },
      {
        role: 'user',
        content: `Today: ${new Date().toISOString().slice(0, 10)}.\n\n== Current notes ==\n${opts.fromScratch ? '(none)' : renderNotes(p)}\n\n== Transcript ==\n${transcript}\n\n${task}
Return ONLY JSON:
{
  "notes": ${NOTE_OPS_SCHEMA},
  "open": ["<up to 4 things still most worth learning about them, for next time>"],
  "who": "<one line: who they are, in plain words; name or they, never he/she>"
}`,
      },
    ],
    { model: MODELS.brain, temperature: 0.2, maxTokens: 6000, signal: opts.signal },
  );
  if (opts.fromScratch) (p.notes = {}), (p.folders = {});
  const changes = applyNoteOps(p, out.notes, { sessionId: opts.sessionId });
  if (out.open?.length) p.open = out.open.slice(0, 4);
  if (out.who) p.expertise = out.who;
  return changes;
}

// All notes as one markdown file, for download.
export function notesMarkdown(p: Person): string {
  const out = [`# ${p.name}`, p.expertise ? `\n${p.expertise}\n` : ''];
  let folder = '';
  for (const n of Object.values(notesOf(p)).sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
    if (dir !== folder) {
      folder = dir;
      if (dir) out.push(`\n## ${dir}/${p.folders?.[dir] ? `\n_${p.folders[dir]}_` : ''}`);
    }
    out.push(`\n### ${n.title}\n_${n.path}_ · ${n.summary}\n\n${n.body.trim()}`);
  }
  return out.join('\n') + '\n';
}
