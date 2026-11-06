// One page, three views: start -> call -> after. Voice uses WebRTC straight to the Live model,
// with the server listening on a sideband; text uses the same note-taker over REST.
import { api, code, esc, renderNotebook, notesCount } from '/ui.js';

const $ = (id) => document.getElementById(id);
const show = (view) => ['start', 'callView', 'after'].forEach((v) => $(v).classList.toggle('hidden', v !== view));

if (new URLSearchParams(location.search).has('lab')) $('lab').classList.remove('hidden');
const state = { mode: 'voice', person: null, sessionId: null, call: null, startedAt: 0, timer: null, openNotes: new Set(), marks: {}, markTimer: null };

// ---------- start ----------
let lookupTimer;
$('name').addEventListener('input', () => {
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(lookup, 350);
});
async function lookup() {
  const name = $('name').value.trim();
  const box = $('returning');
  if (!name) return box.classList.add('hidden');
  try {
    const r = await api(`/api/lookup?name=${encodeURIComponent(name)}`);
    if (r.returning) {
      const n = notesCount(r.person);
      box.innerHTML = `Welcome back, ${esc(r.person.name.split(' ')[0])}. ${n ? `I have ${n} note${n === 1 ? '' : 's'} from last time, so we'll pick up from there.` : `We'll pick up where we left off.`}`;
      box.classList.remove('hidden');
      $('callLabel').textContent = 'Continue talking';
    } else {
      box.classList.add('hidden');
      $('callLabel').textContent = 'Start talking';
    }
  } catch {}
}
$('call').addEventListener('click', () => start('voice'));
$('typeBtn').addEventListener('click', () => start('text'));
$('name').addEventListener('keydown', (e) => e.key === 'Enter' && start('voice'));

async function start(mode) {
  const name = $('name').value.trim();
  if (!name) return $('name').focus();
  state.mode = mode;
  const topic = $('topic').value.trim();
  const link = $('link').value.trim();
  const golden = $('golden').value.split('\n').map((s) => s.trim()).filter(Boolean);
  $('startErr').classList.add('hidden');
  $('call').disabled = $('typeBtn').disabled = true;
  $('call').classList.add('connecting');
  try {
    resetCallView(name);
    show('callView');
    if (mode === 'text') await startText(name, topic, golden, link);
    else await startVoice(name, topic, golden, link);
    startTimer();
  } catch (e) {
    $('startErr').textContent = e.message || String(e);
    $('startErr').classList.remove('hidden');
    show('start');
  } finally {
    $('call').disabled = $('typeBtn').disabled = false;
    $('call').classList.remove('connecting');
  }
}

function resetCallView(name) {
  $('transcript').innerHTML = '';
  $('learned').innerHTML = '';
  $('whoLine').textContent = '';
  $('openBox').classList.add('hidden');
  $('callName').textContent = name;
  $('timer').textContent = '0:00';
  document.body.dataset.mode = state.mode;
  $('typeInput').placeholder = state.mode === 'text' ? 'Type your answer…' : 'Or type here…';
  state.openNotes = new Set();
  state.marks = {};
  state.person = null;
  presence(state.mode === 'text' ? 'thinking' : 'connecting');
}

function startTimer() {
  state.startedAt = Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

// ---------- presence: what's happening right now ----------
const PRESENCE = { connecting: 'Connecting…', listening: 'Listening', speaking: 'Speaking', you: 'Listening', thinking: 'Thinking…', yours: 'Your turn', ended: 'Call ended' };
function presence(s) {
  $('presence').dataset.state = s;
  $('presenceText').textContent = PRESENCE[s] ?? '';
}
// Orb follows the loudest of their voice and the interviewer's.
function meter(streams) {
  const ctx = new AudioContext();
  const analysers = streams.map((s) => {
    const a = ctx.createAnalyser();
    a.fftSize = 512;
    ctx.createMediaStreamSource(s).connect(a);
    return a;
  });
  const buf = new Uint8Array(512);
  const level = (a) => {
    a.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    return Math.sqrt(sum / buf.length);
  };
  let raf;
  const tick = () => {
    const [you, them] = analysers.map(level);
    const lvl = Math.min(1, Math.max(you ?? 0, them ?? 0) * 6);
    $('presence').style.setProperty('--lvl', lvl.toFixed(3));
    const p = $('presence').dataset.state;
    if (p !== 'ended' && p !== 'connecting') {
      if ((them ?? 0) > 0.02) presence('speaking');
      else if ((you ?? 0) > 0.03) presence('you');
      else if (p === 'speaking' || p === 'you') presence('listening');
    }
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => (cancelAnimationFrame(raf), ctx.close());
}

// ---------- text ----------
async function startText(name, topic, golden, link) {
  const r = await api('/api/text/start', { name, topic, golden, link });
  state.person = r.person;
  state.sessionId = r.sessionId;
  renderPerson(r.person, true);
  addMsg('agent', r.decision.say);
  presence('yours');
  setTimeout(() => $('typeInput').focus(), 50);
}

$('typeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('typeInput').value.trim();
  if (!text) return;
  $('typeInput').value = '';
  if (state.mode === 'voice') {
    state.call?.ws.send(JSON.stringify({ type: 'typed', text }));
    return;
  }
  addMsg('person', text);
  presence('thinking');
  notesBusy(true);
  try {
    const r = await api('/api/text/turn', { id: state.person.id, sessionId: state.sessionId, text });
    addMsg('agent', r.decision.say);
    renderPerson(r.person);
    if (r.decision.move === 'wrap') setTimeout(() => finish('later', true), 2500);
  } catch (err) {
    addMsg('agent', `Something went wrong (${err.message}). Try sending that again.`, 'error');
  } finally {
    notesBusy(false);
    presence('yours');
  }
});

// ---------- voice ----------
async function startVoice(name, topic, golden, link) {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).catch(() => {
    throw new Error('The call needs your microphone. Allow it, or choose "type instead".');
  });
  const pc = new RTCPeerConnection();
  let stopMeter = () => {};
  pc.ontrack = (e) => {
    $('remote').srcObject = e.streams[0];
    try {
      stopMeter = meter([mic, e.streams[0]]);
    } catch {}
  };
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
  const dc = pc.createDataChannel('oai-events');
  window.__dcLog = [];
  dc.onmessage = (e) => window.__dcLog.push(JSON.parse(e.data).type);
  await pc.setLocalDescription(await pc.createOffer());
  await iceDone(pc);

  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?name=${encodeURIComponent(name)}${code ? `&code=${encodeURIComponent(code)}` : ''}`;
  const ws = new WebSocket(wsUrl);
  state.call = { pc, ws, mic, agentEl: null, personEl: null, ended: false, stopMeter: () => stopMeter() };

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Could not connect the call. Try again.')), 30000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', name, topic, golden, link, sdp: pc.localDescription.sdp }));
    ws.onerror = () => reject(new Error('Could not reach the server.'));
    ws.onclose = () => {
      clearTimeout(timeout);
      reject(new Error('The call closed before it started.'));
    };
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'answer') {
        clearTimeout(timeout);
        state.sessionId = m.sessionId;
        await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        ws.onmessage = (e2) => onEvent(JSON.parse(e2.data));
        ws.onclose = () => !state.call?.ended && finish('dropped', true);
        presence('listening');
        resolve();
      } else if (m.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(m.message));
      } else onEvent(m);
    };
  });
}

function iceDone(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, 2500);
    pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && (clearTimeout(t), r()));
  });
}

function onEvent(m) {
  const c = state.call;
  switch (m.type) {
    case 'transcript': {
      // Live transcripts stream in pieces; one growing line per speaker turn.
      if (m.role === 'agent') {
        if (!c.agentEl) {
          c.personEl?.classList.remove('partial');
          c.personEl = null;
          c.agentEl = addMsg('agent', '');
        }
        c.agentEl.querySelector('.text').textContent += m.delta;
      } else {
        if (!c.personEl) {
          c.agentEl = null;
          c.personEl = addMsg('person', '');
          c.personEl.classList.add('partial');
        }
        c.personEl.querySelector('.text').textContent += m.delta;
      }
      scrollDown();
      break;
    }
    case 'turn_end':
      // Arrives once their words are final, often after the reply has begun: close their line, not the reply.
      c.personEl?.classList.remove('partial');
      c.personEl = null;
      break;
    case 'thinking':
      notesBusy(m.on);
      break;
    case 'brain':
      renderPerson(m.person);
      break;
    case 'closed':
      presence('ended');
      break;
    case 'ended':
      state.person = m.person;
      if (!c.ended) finish('ended', true);
      else afterView();
      break;
    case 'live_error':
    case 'error':
      console.warn(m);
      break;
  }
}

$('mute').addEventListener('click', () => {
  const t = state.call?.mic.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  $('mute').setAttribute('aria-pressed', String(!t.enabled));
  $('mute').textContent = t.enabled ? 'Mute' : 'Unmute';
});
// Read instead of listen: its voice goes silent, the transcript keeps going.
$('quiet').addEventListener('click', () => {
  const a = $('remote');
  a.muted = !a.muted;
  $('quiet').setAttribute('aria-pressed', String(a.muted));
  $('quiet').textContent = a.muted ? 'Hear it' : 'Read only';
});
$('nbToggle').addEventListener('click', () => document.body.classList.toggle('nb-open'));
// One way to stop. It's always resumable: next time it picks up where you left off.
$('hangup').addEventListener('click', () => finish('later'));

async function finish(reason, already = false) {
  clearInterval(state.timer);
  presence('ended');
  notesBusy(false);
  document.body.classList.remove('nb-open');
  if (state.mode === 'text') {
    show('after');
    afterLoading();
    if (!already) {
      const r = await api('/api/text/end', { id: state.person.id, sessionId: state.sessionId, reason }).catch(() => null);
      if (r) state.person = r.person;
    }
    return afterView();
  }
  const c = state.call;
  if (!c || c.ended) return;
  c.ended = true;
  c.stopMeter();
  c.mic.getTracks().forEach((t) => t.stop());
  c.pc.close();
  show('after');
  afterLoading();
  if (!already && c.ws.readyState === WebSocket.OPEN) {
    // The server tidies the notes, then sends 'ended'.
    c.ws.send(JSON.stringify({ type: 'hangup', reason }));
    setTimeout(() => !state.afterShown && afterView(), 45000); // in case 'ended' never comes
  } else afterView();
}

// ---------- rendering ----------
function addMsg(role, text, extra = '') {
  const el = document.createElement('div');
  el.className = `line ${role} ${extra}`;
  el.innerHTML = `<span class="speaker">${role === 'agent' ? 'Interviewer' : 'You'}</span><span class="text"></span>`;
  el.querySelector('.text').textContent = text;
  $('transcript').appendChild(el);
  scrollDown();
  return el;
}
const scrollDown = () => ($('transcript').scrollTop = $('transcript').scrollHeight);
const notesBusy = (on) => ($('notesState').textContent = on ? 'taking notes…' : '');

// Highlight notes that are new or changed since the last render, for a few seconds.
function renderPerson(p, first = false) {
  if (!p) return;
  const prev = state.person?.notes ?? {};
  if (!first)
    for (const [path, n] of Object.entries(p.notes ?? {})) {
      if (!prev[path]) state.marks[path] = 'add';
      else if (prev[path].updatedAt !== n.updatedAt && !state.marks[path]) state.marks[path] = 'edit';
    }
  state.person = p;
  $('whoLine').textContent = p.expertise || '';
  $('bgBox').classList.toggle('hidden', !p.background?.brief);
  $('bg').textContent = p.background?.brief ?? '';
  $('nbCount').textContent = notesCount(p);
  renderNotebook($('learned'), p, { marks: state.marks, open: state.openNotes });
  $('openBox').classList.toggle('hidden', !p.open?.length);
  $('openList').innerHTML = (p.open ?? []).map((x) => `<li>${esc(x)}</li>`).join('');
  renderSources(p);
  clearTimeout(state.markTimer);
  state.markTimer = setTimeout(() => {
    state.marks = {};
    renderNotebook($('learned'), state.person, { open: state.openNotes });
  }, 8000);
}

// ---------- after ----------
function afterLoading() {
  state.afterShown = false;
  $('afterTitle').textContent = 'Saving your notes…';
  $('afterSummary').textContent = 'Tidying up what you said into your notebook.';
  $('afterNotes').innerHTML = '';
  $('report').innerHTML = '';
}

async function afterView() {
  state.afterShown = true;
  show('after');
  const p = state.person;
  $('afterTitle').textContent = `Thanks, ${p.name.split(' ')[0]}.`;
  $('afterSummary').textContent = p.expertise || '';
  renderNotebook($('afterNotes'), p);
  const blob = new Blob([notesMarkdown(p)], { type: 'text/markdown' });
  $('download').href = URL.createObjectURL(blob);
  $('download').download = `${p.id}-notes.md`;
  $('report').innerHTML = '<p class="muted">Reviewing the conversation…</p>';
  try {
    const { report: r } = await api('/api/report', { id: p.id, sessionId: state.sessionId });
    $('report').innerHTML = renderReport(r, p);
  } catch (e) {
    $('report').innerHTML = `<p class="err">Couldn't review the conversation: ${esc(e.message)}</p>`;
  }
}

function renderReport(r, p) {
  const s = r.stats;
  const max = Math.max(1, ...s.newPerTurn);
  const list = (title, xs, cls = '') => (xs?.length ? `<section class="${cls}"><h3>${title}</h3><ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : '');
  return `
  <h2>This conversation</h2>
  <p class="headline">${esc(r.judge.headline)}</p>
  <div class="stats">
    <div><b>${s.personTurns}</b><span>answers</span></div>
    <div><b>${s.notesTouched}</b><span>notes written or updated</span></div>
    <div><b>${s.notes}</b><span>notes in total</span></div>
    ${r.goldenRecall != null ? `<div><b>${Math.round(r.goldenRecall * 100)}%</b><span>sealed facts</span></div>` : ''}
  </div>
  ${s.newPerTurn.length ? `<section><h3>Notes changed per answer</h3><div class="curve" title="When this flattens, the conversation has stopped adding much">${s.newPerTurn.map((n) => `<i style="--h:${n / max}" title="${n}"></i>`).join('')}</div>${s.newPerTurn.some(Boolean) ? '' : '<p class="muted small">No answer added anything the notebook didn\'t already have.</p>'}</section>` : ''}
  ${list('Ask next time', r.judge.nextQuestions)}
  ${r.judge.gaps?.length ? `<section><h3>Still missing</h3><ul>${r.judge.gaps.map((g) => `<li><b>${esc(g.thread)}</b> · ${esc(g.missing)}</li>`).join('')}</ul></section>` : ''}
  ${r.golden ? `<section><h3>Sealed facts</h3><ul class="golden">${r.golden.map((g) => `<li class="${g.captured}"><span>${g.captured}</span>${esc(g.fact)}</li>`).join('')}</ul></section>` : ''}
  <details class="review"><summary>Review of the interviewer and the notes</summary>
    ${list('Interviewer mistakes', r.judge.interviewerIssues)}
    ${list('Notes not supported by what they said', r.judge.notesIssues)}
    <p class="muted small">Reviewed by a model from a different family than the one that interviewed and took the notes.</p>
  </details>`;
}

function notesMarkdown(p) {
  const notes = Object.values(p.notes ?? {}).sort((a, b) => a.path.localeCompare(b.path));
  return [`# ${p.name}`, p.expertise ? `\n${p.expertise}` : '', ...notes.map((n) => `\n## ${n.title}\n_${n.path}_ · ${n.summary}\n\n${n.body.trim()}`)].join('\n') + '\n';
}

$('again').addEventListener('click', () => {
  $('name').value = state.person.name;
  show('start');
  lookup();
});

// ---------- connected tools (optional) ----------
// A tool opens its own sign-in in a popup, so a call keeps going. The server reads it afterwards.
let toolPresets = [];
api('/api/status')
  .then((s) => {
    toolPresets = s.tools ?? [];
    document.querySelectorAll('[data-tools]').forEach(renderToolButtons);
  })
  .catch(() => {});

function renderToolButtons(el) {
  const on = new Set((state.person?.connections ?? []).filter((c) => c.status !== 'failed' && c.status !== 'pending').map((c) => c.id));
  el.innerHTML =
    toolPresets.map((t) => `<button type="button" class="pill${on.has(t.id) ? ' on' : ''}" data-server="${esc(t.id)}" title="${esc(t.what)}">${on.has(t.id) ? '✓ ' : ''}${esc(t.label)}</button>`).join('') +
    `<form><input name="url" type="url" placeholder="Other MCP server (https://…)" aria-label="Other MCP server URL" /><button class="pill" type="submit">Connect</button></form>`;
  el.querySelectorAll('[data-server]').forEach((b) => b.addEventListener('click', () => connectTool(b.dataset.server)));
  el.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = e.target.url.value.trim();
    if (url) connectTool(url);
  });
}

function connectTool(server) {
  const name = state.person?.name ?? $('name').value.trim();
  if (!name) {
    $('name').focus();
    return;
  }
  const q = new URLSearchParams({ name, server, ...(code ? { code } : {}) });
  window.open(`/api/connect?${q}`, 'connect-tool', 'width=520,height=720');
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'source-connected') return;
  refreshSources();
});

let srcTimer;
async function refreshSources() {
  clearTimeout(srcTimer);
  srcTimer = undefined;
  const name = state.person?.name ?? $('name').value.trim();
  if (!name) return;
  try {
    const r = await api(`/api/lookup?name=${encodeURIComponent(name)}`);
    if (!r.person) return;
    if (state.person) renderPerson({ ...state.person, connections: r.person.connections, sources: r.person.sources });
    else {
      state.startPerson = r.person;
      document.querySelectorAll('[data-tools]').forEach((el) => renderToolButtonsFor(el, r.person));
    }
    if ((r.person.connections ?? []).some((c) => c.status === 'reading')) srcTimer = setTimeout(refreshSources, 4000);
  } catch {}
}
function renderToolButtonsFor(el, person) {
  const keep = state.person;
  state.person = person;
  renderToolButtons(el);
  state.person = keep;
}

function renderSources(p) {
  const conns = p.connections ?? [];
  const notes = p.sources ?? [];
  const label = (id) => conns.find((c) => c.id === id)?.label ?? id;
  const status = conns
    .map((c) => {
      const s = c.status === 'reading' ? 'reading…' : c.status === 'ready' ? `read ${c.lastRead ? new Date(c.lastRead).toLocaleDateString() : ''}` : c.status === 'pending' ? 'waiting for sign-in' : `couldn't read${c.error ? `: ${c.error}` : ''}`;
      return `<div class="src-conn">${esc(c.label)} · ${esc(s)}</div>`;
    })
    .join('');
  $('srcHint').classList.toggle('hidden', notes.length > 0);
  $('srcList').innerHTML =
    status +
    notes
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((n) => `<div class="src-note"><b>${esc(n.title)}</b><span>${esc(n.summary)}</span><div class="muted" style="font-size:11.5px;margin-top:3px">${esc(label(n.from))}</div><button class="x" type="button" data-strike="${esc(n.path)}" title="Strike this">×</button></div>`)
      .join('');
  $('srcList').querySelectorAll('[data-strike]').forEach((b) =>
    b.addEventListener('click', async () => {
      const r = await api('/api/sources/strike', { id: p.id, path: b.dataset.strike }).catch(() => null);
      if (r?.person) renderPerson(r.person);
    }),
  );
  document.querySelectorAll('[data-tools]').forEach(renderToolButtons);
  if (conns.some((c) => c.status === 'reading') && !srcTimer) srcTimer = setTimeout(refreshSources, 4000);
}

$('connectBtn').addEventListener('click', () => {
  const open = $('connectPanel').classList.toggle('hidden') === false;
  $('connectBtn').setAttribute('aria-expanded', String(open));
});
