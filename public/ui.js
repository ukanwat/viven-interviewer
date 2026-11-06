// Shared bits for every page: API with passcode, escaping, light markdown, and the notebook view.
export let code = new URLSearchParams(location.search).get('code') || localStorage.getItem('code') || '';
if (code) localStorage.setItem('code', code);

export async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-passcode': code },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    code = prompt('Passcode') || '';
    localStorage.setItem('code', code);
    return api(path, body);
  }
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Enough markdown for notes: bullets, bold, italics, quotes.
export function md(text) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|\W)_(.+?)_(?=\W|$)/g, '$1<i>$2</i>')
      .replace(/“([^”]+)”|"([^"]+)"/g, (m) => `<q>${m.slice(1, -1)}</q>`);
  const out = [];
  let list = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+/.test(line);
    if (bullet && !list) out.push('<ul>'), (list = true);
    if (!bullet && list) out.push('</ul>'), (list = false);
    if (bullet) out.push(`<li>${inline(line.replace(/^[-*•]\s+/, ''))}</li>`);
    else if (line) out.push(`<p>${inline(line.replace(/^#+\s*/, ''))}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

// The notebook: folders (with their descriptions) and notes, any depth. `marks` maps a path to
// 'add' | 'edit' to highlight what just changed; `open` keeps expanded notes expanded across renders.
export function renderNotebook(el, person, { marks = {}, open = new Set() } = {}) {
  const notes = Object.values(person?.notes ?? {});
  if (!notes.length) {
    el.innerHTML = `<p class="nb-empty">Nothing yet. Notes appear here as you talk.</p>`;
    return;
  }
  // Build a folder tree.
  const root = { dirs: new Map(), notes: [] };
  for (const n of notes) {
    const parts = n.path.split('/');
    let node = root;
    let at = '';
    for (const part of parts.slice(0, -1)) {
      at = at ? `${at}/${part}` : part;
      if (!node.dirs.has(part)) node.dirs.set(part, { path: at, dirs: new Map(), notes: [] });
      node = node.dirs.get(part);
    }
    node.notes.push(n);
  }
  const folders = person.folders ?? {};
  const count = (node) => node.notes.length + [...node.dirs.values()].reduce((s, d) => s + count(d), 0);
  const hasMark = (node) => node.notes.some((n) => marks[n.path]) || [...node.dirs.values()].some(hasMark);
  const noteHtml = (n) => {
    const mark = marks[n.path];
    return `<details class="nb-note${mark ? ` is-${mark}` : ''}" data-path="${esc(n.path)}"${open.has(n.path) ? ' open' : ''}>
      <summary><span class="nb-title">${esc(n.title)}</span>${mark ? `<span class="nb-badge">${mark === 'add' ? 'new' : 'updated'}</span>` : ''}<span class="nb-sum">${esc(n.summary)}</span></summary>
      <div class="nb-body">${md(n.body)}</div>
    </details>`;
  };
  const dirHtml = (name, node) => `<details class="nb-dir" open data-dir="${esc(node.path)}">
      <summary><span class="nb-dirname">${esc(name.replace(/-/g, ' '))}</span><span class="nb-count">${count(node)}</span>${folders[node.path] ? `<span class="nb-desc">${esc(folders[node.path])}</span>` : ''}</summary>
      <div class="nb-children">${children(node)}</div>
    </details>`;
  const children = (node) =>
    [...node.notes].sort((a, b) => a.title.localeCompare(b.title)).map(noteHtml).join('') +
    [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, d]) => dirHtml(k, d)).join('');
  el.innerHTML = children(root);
  el.querySelectorAll('.nb-note').forEach((d) => d.addEventListener('toggle', () => (d.open ? open.add(d.dataset.path) : open.delete(d.dataset.path))));
  const first = el.querySelector('.is-add, .is-edit');
  if (first && hasMark(root)) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function notesCount(person) {
  return Object.keys(person?.notes ?? {}).length;
}

export const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
