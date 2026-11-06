// One page, three views: start -> call -> after. Voice uses WebRTC straight to the Live model,
// with this server steering over a sideband; text uses the same brain over REST.
const $ = (id) => document.getElementById(id);
const show = (view) => ['start', 'callView', 'after'].forEach((v) => $(v).classList.toggle('hidden', v !== view));

let code = new URLSearchParams(location.search).get('code') || localStorage.getItem('code') || '';
if (code) localStorage.setItem('code', code);

async function api(path, body) {
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

// ---------- state ----------
if (new URLSearchParams(location.search).has('lab')) $('lab').classList.remove('hidden');
const state = { mode: 'voice', person: null, sessionId: null, seenItems: new Set(), call: null, startedAt: 0, timer: null };

// ---------- start view ----------
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
      const p = r.person;
      const open = p.threads.find((t) => t.id === p.activeThreadId) || p.threads.find((t) => t.status === 'open');
      box.innerHTML = `Welcome back, ${esc(p.name)}. I remember ${p.items.length} thing${p.items.length === 1 ? '' : 's'} you taught me${open ? `; we'll pick up from <b>${esc(open.title)}</b>` : ''}.`;
      box.classList.remove('hidden');
      $('callLabel').textContent = 'Continue';
    } else {
      box.classList.add('hidden');
      $('callLabel').textContent = 'Call';
    }
  } catch {}
}
$('typeMode').addEventListener('change', (e) => {
  state.mode = e.target.checked ? 'text' : 'voice';
  $('call').querySelector('.dot').style.display = state.mode === 'text' ? 'none' : '';
  $('callLabel').textContent = state.mode === 'text' ? 'Start' : $('returning').classList.contains('hidden') ? 'Call' : 'Continue';
});
$('call').addEventListener('click', start);
$('name').addEventListener('keydown', (e) => e.key === 'Enter' && start());

async function start() {
  const name = $('name').value.trim();
  if (!name) return $('name').focus();
  const topic = $('topic').value.trim();
  const link = $('link').value.trim();
  const golden = $('golden').value.split('\n').map((s) => s.trim()).filter(Boolean);
  $('startErr').classList.add('hidden');
  $('call').disabled = true;
  $('call').classList.add('connecting');
  try {
    resetCallView(name);
    if (state.mode === 'text') await startText(name, topic, golden, link);
    else await startVoice(name, topic, golden, link);
    show('callView');
    startTimer();
  } catch (e) {
    $('startErr').textContent = e.message || String(e);
    $('startErr').classList.remove('hidden');
    show('start');
  } finally {
    $('call').disabled = false;
    $('call').classList.remove('connecting');
  }
}

function resetCallView(name) {
  $('transcript').innerHTML = '';
  $('learned').innerHTML = '';
  $('threads').innerHTML = '';
  $('why').innerHTML = '';
  $('expertise').textContent = '';
  $('callName').textContent = name;
  $('callMode').textContent = state.mode === 'text' ? '· typing' : '· voice';
  $('mute').classList.toggle('hidden', state.mode === 'text');
  $('quiet').classList.toggle('hidden', state.mode === 'text');
  $('typeInput').placeholder = state.mode === 'text' ? "Type your answer… (or say 'call me later')" : 'Or type here during the call…';
  state.seenItems = new Set();
  state.firstRender = true;
}

function startTimer() {
  state.startedAt = Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

// ---------- text channel ----------
async function startText(name, topic, golden, link) {
  const r = await api('/api/text/start', { name, topic, golden, link });
  state.person = r.person;
  state.sessionId = r.sessionId;
  renderPerson(r.person);
  addMsg('agent', r.decision.say);
  showWhy(r.decision);
  $('liveDot').classList.add('on');
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
  thinking(true);
  try {
    const r = await api('/api/text/turn', { id: state.person.id, sessionId: state.sessionId, text });
    state.person = r.person;
    addMsg('agent', r.decision.say, r.decision);
    showWhy(r.decision, r.ms);
    renderPerson(r.person);
    if (r.decision.move === 'wrap') setTimeout(() => finish('later', true), 2500);
  } catch (err) {
    addMsg('agent', `(Something went wrong: ${err.message}. Try sending that again.)`);
  } finally {
    thinking(false);
  }
});

// ---------- voice channel ----------
async function startVoice(name, topic, golden, link) {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).catch(() => {
    throw new Error('Microphone access is needed for the call. Allow it, or tick "Type instead".');
  });
  const pc = new RTCPeerConnection();
  pc.ontrack = (e) => ($('remote').srcObject = e.streams[0]);
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
  const dc = pc.createDataChannel('oai-events');
  window.__pc = pc; // debugging aid
  window.__dcLog = [];
  dc.onmessage = (e) => window.__dcLog.push(JSON.parse(e.data).type);
  pc.onconnectionstatechange = () => window.__dcLog.push('pc:' + pc.connectionState);
  await pc.setLocalDescription(await pc.createOffer());
  await iceDone(pc);

  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?name=${encodeURIComponent(name)}${code ? `&code=${encodeURIComponent(code)}` : ''}`;
  const ws = new WebSocket(wsUrl);
  state.call = { pc, ws, mic, agentEl: null, personEl: null, ended: false };

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Could not connect the call. Try again.')), 30000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', name, topic, golden, link, sdp: pc.localDescription.sdp }));
    ws.onerror = () => reject(new Error('Could not reach the server.'));
    ws.onclose = () => {
      clearTimeout(timeout);
      reject(new Error('The call was closed before it started.'));
    };
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'answer') {
        clearTimeout(timeout);
        state.sessionId = m.sessionId;
        await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        ws.onmessage = (e2) => onEvent(JSON.parse(e2.data));
        ws.onclose = () => !state.call?.ended && finish('dropped', true);
        resolve();
      } else if (m.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(m.message));
      } else onEvent(m);
    };
  });
  $('liveDot').classList.add('on');
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
      // Live transcripts stream in pieces; keep one growing bubble per speaker turn.
      if (m.role === 'agent') {
        if (!c.agentEl) {
          c.personEl?.classList.remove('partial');
          c.personEl = null;
          c.agentEl = addMsg('agent', '');
        }
        c.agentEl.firstChild.textContent += m.delta;
      } else {
        if (!c.personEl) {
          c.agentEl = null;
          c.personEl = addMsg('person', '');
          c.personEl.classList.add('partial');
        }
        c.personEl.firstChild.textContent += m.delta;
      }
      scrollDown();
      break;
    }
    case 'turn_end':
      c.personEl?.classList.remove('partial');
      c.personEl = null;
      c.agentEl = null;
      break;
    case 'thinking':
      thinking(m.on);
      break;
    case 'early':
      showWhy({ move: m.move, say: m.say, reason: '' }, m.ms, true);
      break;
    case 'brain':
      state.person = m.person;
      renderPerson(m.person);
      showWhy(m.decision, m.ms);
      break;
    case 'live_error':
      console.warn('live error', m.code);
      break;
    case 'error':
      console.warn(m.message);
      break;
    case 'closed':
      $('liveDot').classList.remove('on');
      break;
    case 'ended':
      state.person = m.person;
      if (!c.ended) finish('ended', true);
      else afterView();
      break;
  }
}

$('mute').addEventListener('click', () => {
  const t = state.call?.mic.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  $('mute').textContent = t.enabled ? 'Mute mic' : 'Unmute mic';
});
// Read instead of listen: its voice goes silent, the transcript keeps going.
$('quiet').addEventListener('click', () => {
  const a = $('remote');
  a.muted = !a.muted;
  $('quiet').textContent = a.muted ? 'Hear it again' : 'Read only';
});
// One way to stop. It's always resumable: next time it picks up where you left off.
$('hangup').addEventListener('click', () => finish('later'));

async function finish(reason, already = false) {
  clearInterval(state.timer);
  $('liveDot').classList.remove('on');
  thinking(false);
  if (state.mode === 'text') {
    if (!already) {
      const r = await api('/api/text/end', { id: state.person.id, sessionId: state.sessionId, reason }).catch(() => null);
      if (r) state.person = r.person;
    }
    return afterView();
  }
  const c = state.call;
  if (!c || c.ended) return;
  c.ended = true;
  c.mic.getTracks().forEach((t) => t.stop());
  c.pc.close();
  if (!already && c.ws.readyState === WebSocket.OPEN) {
    // Server saves memory and the summary, then sends 'ended'.
    c.ws.send(JSON.stringify({ type: 'hangup', reason }));
    show('after');
    $('afterTitle').textContent = 'Saving…';
    $('report').innerHTML = '<p class="muted">Saving what you taught me…</p>';
    setTimeout(() => afterView(), 15000); // in case 'ended' never comes
  } else afterView();
}

// ---------- rendering ----------
function addMsg(role, text, decision) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  $('transcript').appendChild(el);
  scrollDown();
  return el;
}
const scrollDown = () => ($('transcript').scrollTop = $('transcript').scrollHeight);
const thinking = (on) => $('thinking').classList.toggle('hidden', !on);

const GROUPS = [
  ['Stories & decisions', ['story', 'decision', 'case', 'outcome']],
  ['What they value & believe', ['value', 'belief', 'disagreement']],
  ['How they think & do things', ['rule', 'exception', 'cue', 'howto']],
  ['How they are with people', ['reaction', 'relationship', 'style', 'person']],
  ['About them', ['fact', 'context']],
];

function renderPerson(p) {
  if (!p) return;
  $('expertise').textContent = p.expertise ? p.expertise : '';
  $('bgBox').classList.toggle('hidden', !p.background?.brief);
  $('bg').textContent = p.background?.brief ?? '';
  const box = $('learned');
  box.innerHTML = '';
  if (!p.items.length) box.innerHTML = '<p class="empty">Nothing yet. It fills in as you talk.</p>';
  for (const [title, kinds] of GROUPS) {
    const items = p.items.filter((i) => kinds.includes(i.kind));
    if (!items.length) continue;
    const g = document.createElement('div');
    g.className = 'group';
    g.innerHTML = `<div class="group-title">${title} · ${items.length}</div>`;
    for (const i of items) {
      const key = i.id || i.text;
      const fresh = !state.firstRender && !state.seenItems.has(key);
      state.seenItems.add(key);
      const el = document.createElement('div');
      el.className = `item${fresh ? ' fresh' : ''}`;
      el.innerHTML = `<span class="tag ${i.novelty}">${i.novelty === 'new' ? 'new' : 'textbook'}</span>${esc(i.text)}${i.why ? `<span class="why">why: ${esc(i.why)}</span>` : ''}${i.evidence ? `<span class="ev">“${esc(i.evidence)}”</span>` : ''}`;
      g.appendChild(el);
    }
    box.appendChild(g);
  }
  state.firstRender = false;
  $('threads').innerHTML = p.threads
    .map(
      (t) =>
        `<div class="thread${t.id === p.activeThreadId ? ' active' : ''}">${esc(t.title)}<span class="st">${t.status}</span>${t.gaps?.length ? `<div class="gaps">missing: ${esc(t.gaps.slice(0, 2).join('; '))}</div>` : ''}</div>`,
    )
    .join('') || '<p class="empty">—</p>';
}

function showWhy(d, ms, early) {
  if (!d) return;
  const parts = [];
  if (d.reason) parts.push(esc(d.reason));
  if (state.mode !== 'text' && d.question) parts.push(`<span class="muted">e.g. “${esc(d.question)}”</span>`);
  if (ms) parts.push(`<span class="muted small">${d.label ? `read as ${esc(d.label)} · ` : ''}${(ms / 1000).toFixed(1)}s${early ? ', spoken early' : ''}</span>`);
  $('why').innerHTML = parts.join('<br>');
}

// ---------- after the call ----------
async function afterView() {
  show('after');
  const p = state.person;
  $('afterTitle').textContent = `Thanks, ${p.name.split(' ')[0]}`;
  $('afterSummary').textContent = p.summary || '';
  $('report').innerHTML = '<p class="muted">Writing the report…</p>';
  try {
    const { report: r } = await api('/api/report', { id: p.id, sessionId: state.sessionId });
    $('report').innerHTML = renderReport(r, p);
  } catch (e) {
    $('report').innerHTML = `<p class="err">Couldn't write the report: ${esc(e.message)}</p>`;
  }
}

function renderReport(r, p) {
  const s = r.stats;
  const max = Math.max(1, ...s.newPerTurn);
  const items = p.items.filter((i) => i.sessionId === state.sessionId);
  return `
  <p><b>${esc(r.judge.headline)}</b></p>
  <div class="stats">
    <div class="stat"><b>${s.newItems}</b><span>new pieces of know-how</span></div>
    <div class="stat"><b>${s.textbookItems}</b><span>textbook (low value)</span></div>
    <div class="stat"><b>${s.personTurns}</b><span>answers</span></div>
    <div class="stat"><b>${s.repeatedQuestions}</b><span>repeated questions</span></div>
    ${r.goldenRecall != null ? `<div class="stat"><b>${Math.round(r.goldenRecall * 100)}%</b><span>sealed facts captured</span></div>` : ''}
  </div>
  <section><h3>New know-how per answer</h3><div class="curve">${s.newPerTurn.map((n) => `<div style="height:${(n / max) * 100}%" title="${n}"></div>`).join('')}</div></section>
  ${list('Captured, strongest', r.judge.strongest)}
  ${r.judge.gaps?.length ? `<section><h3>Gaps</h3><ul>${r.judge.gaps.map((g) => `<li><b>${esc(g.thread)}:</b> ${esc(g.missing)}</li>`).join('')}</ul></section>` : ''}
  ${list('Ask next time', r.judge.nextQuestions)}
  ${r.golden ? `<section><h3>Sealed facts</h3>${r.golden.map((g) => `<div class="golden-row"><span class="g ${g.captured}">${g.captured}</span><span>${esc(g.fact)}${g.evidence ? ` <span class="muted">— “${esc(g.evidence)}”</span>` : ''}</span></div>`).join('')}</section>` : ''}
  ${list('Interviewer mistakes (judge)', r.judge.interviewerIssues)}
  <section><h3>Everything captured this session (${items.length})</h3><ul>${items.map((i) => `<li><span class="tag ${i.novelty}">${i.novelty}</span>[${i.kind}] ${esc(i.text)}${i.why ? ` <span class="muted">— why: ${esc(i.why)}</span>` : ''}</li>`).join('')}</ul></section>
  <p class="muted small">Judge: a different model family from the interviewer's brain.</p>`;
}
const list = (title, xs) => (xs?.length ? `<section><h3>${title}</h3><ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : '');

$('again').addEventListener('click', () => {
  $('name').value = state.person.name;
  show('start');
  lookup();
});

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
