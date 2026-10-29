// Record page: live recording with a provisional transcript, upload, and past sessions.
// live.js / upload.js / turns.js are imported on demand so the page still works if one fails to load.

import { analyzeRules } from './analyze.js';
import {
  SPEAKER_COLORS, DEFAULT_AGE_BAND, newId, saveSession, saveEmbeddings, listSessions, deleteSession,
} from './store.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = sec => { sec = Math.max(0, Math.round(sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
const colorOf = id => SPEAKER_COLORS[id % SPEAKER_COLORS.length];
const TAG_THROTTLE_MS = 2500;

// ---------- Setup ----------
function expectedSpeakers() {
  const n = parseInt($('speakerCount').value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 12) : 0;
}

// Turns a finished capture into a saved session, then opens its dashboard.
async function finish(capture, source, statusEl) {
  statusEl.textContent = 'Building turns…';
  const { buildTurns } = await import('./turns.js');
  const turns = buildTurns(capture.phrases || [], capture.windows || []);
  if (!turns.length) { statusEl.textContent = 'No speech was captured, so nothing was saved.'; return; }
  const ids = [...new Set(turns.map(t => t.speaker))].sort((a, b) => a - b);
  const session = {
    id: newId(), createdAt: new Date().toISOString(), title: 'Untitled discussion', ageBand: DEFAULT_AGE_BAND, source,
    durationSec: capture.durationSec || turns[turns.length - 1].end,
    speakers: ids.map(id => ({ id, name: `Speaker ${id + 1}`, color: colorOf(id) })),
    phrases: capture.phrases || [], windows: capture.windows || [], turns,
    analysis: { rules: null, claude: null },
  };
  statusEl.textContent = 'Scoring…';
  try { session.analysis.rules = analyzeRules(session); } catch (e) { console.error('analyzeRules failed', e); }
  statusEl.textContent = 'Saving…';
  await saveSession(session);
  if (capture.embeddings?.data) await saveEmbeddings(session.id, capture.embeddings).catch(e => console.warn('embeddings not saved', e));
  location.href = `report.html#${encodeURIComponent(session.id)}`;
}

// ---------- Live ----------
const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const liveSupported = !!(SR && navigator.mediaDevices?.getUserMedia);
if (!liveSupported) { $('unsupported').hidden = false; $('startBtn').disabled = true; }

let live = null;           // { handle, phrases, startedAt, timerId, tagTimer, lastTag, turnTags }

function provisionalTurns(phrases) {
  const turns = [];
  for (const p of phrases) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === p.speaker && p.start - last.end < 2) {
      last.end = Math.max(last.end, p.end); last.text += ' ' + p.text;
    } else turns.push({ id: `t${turns.length + 1}`, speaker: p.speaker, start: p.start, end: p.end, text: p.text, signals: {} });
  }
  return turns;
}

function renderLive() {
  if (!live) return;
  const turns = provisionalTurns(live.phrases);
  const talk = new Map();
  for (const p of live.phrases) talk.set(p.speaker, (talk.get(p.speaker) || 0) + Math.max(0, p.end - p.start));
  const total = [...talk.values()].reduce((a, b) => a + b, 0) || 1;
  $('liveBars').innerHTML = [...talk.keys()].sort((a, b) => a - b).map(id => {
    const pct = Math.round(100 * talk.get(id) / total);
    return `<div class="bar-row"><span class="name"><span class="dot" style="--c:${colorOf(id)}"></span>Speaker ${id + 1}</span>
      <div class="bar-track" role="img" aria-label="Speaker ${id + 1}: ${pct}% of talk"><div class="bar-fill" style="width:${pct}%;--c:${colorOf(id)}"></div></div>
      <span class="num">${pct}%</span></div>`;
  }).join('') || '<p class="muted">Waiting for speech…</p>';

  const box = $('liveTranscript');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = turns.map(t => {
    const tags = live.turnTags?.[t.id];
    return `<div class="turn"><span class="time">${clock(t.start)}</span><div>
      <span class="who" style="--c:${colorOf(t.speaker)}">Speaker ${t.speaker + 1}</span>
      <p class="text">${esc(t.text)}</p>${tagChips(tags)}</div></div>`;
  }).join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function tagChips(tags) {
  if (!tags) return '';
  const chips = [
    ...(tags.questions || []).map(q => `<span class="tag${q.deep ? ' deep' : ''}">${esc(q.deep ? 'deep question' : 'question')}: ${esc(q.type)}</span>`),
    ...(tags.reasoning || []).map(r => `<span class="tag">${esc(r)}</span>`),
    ...(tags.buildsOn?.explicit ? ['<span class="tag">builds on</span>'] : []),
  ];
  return chips.length ? `<div class="tags">${chips.join('')}</div>` : '';
}

// Rules tagger on the turns so far, at most once per TAG_THROTTLE_MS.
function scheduleTagging() {
  if (!live || live.tagTimer) return;
  const wait = Math.max(0, TAG_THROTTLE_MS - (Date.now() - live.lastTag));
  live.tagTimer = setTimeout(() => {
    if (!live) return;
    live.tagTimer = null; live.lastTag = Date.now();
    const turns = provisionalTurns(live.phrases);
    const ids = [...new Set(turns.map(t => t.speaker))];
    try {
      const r = analyzeRules({
        id: 'live', ageBand: DEFAULT_AGE_BAND, source: 'live', durationSec: (Date.now() - live.startedAt) / 1000,
        speakers: ids.map(id => ({ id, name: `Speaker ${id + 1}`, color: colorOf(id) })),
        phrases: live.phrases, windows: [], turns, analysis: {},
      });
      live.turnTags = r?.turnTags || {};
    } catch (e) { console.warn('live tagging failed', e); }
    renderLive();
  }, wait);
}

const STAGES = {
  mic: 'Asking for the microphone…', 'speaker-model': 'Loading the voice model…', 'asr-model': 'Loading the speech model…',
  listening: 'Listening.', decode: 'Reading the file…', speakers: 'Finding speakers…', transcribe: 'Transcribing…',
  regroup: 'Grouping speakers…', finishing: 'Finishing…', done: 'Done.',
};
const stageText = s => s?.message || STAGES[s?.stage] || '';

function statusText(s) {
  if (s == null) return '';
  if (typeof s === 'string') return s;
  if (s.stage === 'speakers' && s.live) return '';   // frequent live talk-time update; bars come from phrases
  const pct = typeof s.progress === 'number' && s.progress < 1 ? ` ${Math.round(s.progress * 100)}%` : '';
  return stageText(s) + pct;
}

async function startLiveRec() {
  const status = $('liveStatus');
  status.textContent = 'Loading…';
  $('startBtn').disabled = true;
  try {
    const { startLive } = await import('./live.js');
    live = { phrases: [], startedAt: Date.now(), lastTag: 0, tagTimer: null, turnTags: {} };
    live.handle = await startLive({
      expectedSpeakers: expectedSpeakers(),
      onPhrase: p => { if (!live) return; live.phrases.push({ ...p, speaker: p.speaker ?? 0 }); renderLive(); scheduleTagging(); },
      onStatus: s => {
        if (s?.stage === 'relabel') { relabelLive(s.phrases); return; }
        const t = statusText(s); if (t) status.textContent = t;
      },
    });
    live.startedAt = Date.now();
    live.timerId = setInterval(() => { $('timer').textContent = clock((Date.now() - live.startedAt) / 1000); }, 500);
    $('startBtn').hidden = true; $('stopBtn').hidden = false; $('recIndicator').hidden = false;
    $('livePanel').hidden = false; $('uploadFile').disabled = true;
    if (status.textContent === 'Loading…') status.textContent = 'Listening.';
    renderLive();
  } catch (e) {
    console.error(e);
    live = null;
    status.innerHTML = `<span class="error">${esc(e?.message || 'Could not start recording.')}</span>`;
    $('startBtn').disabled = !liveSupported;
  }
}

// Live speaker colours are revised as the full regroup sees more speech.
function relabelLive(updates) {
  if (!live) return;
  const byId = new Map(updates.map(u => [u.id, u.speaker]));
  for (const p of live.phrases) if (byId.has(p.id)) p.speaker = byId.get(p.id) ?? p.speaker;
  renderLive(); scheduleTagging();
}

async function stopLiveRec() {
  if (!live) return;
  const status = $('liveStatus');
  const cur = live;
  $('stopBtn').disabled = true;
  clearInterval(cur.timerId); clearTimeout(cur.tagTimer);
  status.textContent = 'Stopping: regrouping speakers…';
  try {
    const capture = await cur.handle.stop();
    live = null;
    $('recIndicator').hidden = true;
    await finish(capture, 'live', status);
  } catch (e) {
    console.error(e);
    status.innerHTML = `<span class="error">${esc(e?.message || 'Something went wrong while finishing.')}</span>`;
  } finally {
    live = null;
    $('stopBtn').hidden = true; $('stopBtn').disabled = false;
    $('startBtn').hidden = false; $('startBtn').disabled = !liveSupported;
    $('recIndicator').hidden = true; $('uploadFile').disabled = false;
  }
}

$('startBtn').addEventListener('click', startLiveRec);
$('stopBtn').addEventListener('click', stopLiveRec);
addEventListener('beforeunload', e => { if (live) { e.preventDefault(); e.returnValue = ''; } });

// ---------- Upload ----------
// onProgress may send a number (0–1 or 0–100) or an object; show whatever it gives.
function readProgress(p) {
  if (typeof p === 'number') return { pct: p <= 1 ? p * 100 : p, text: '' };
  if (!p || typeof p !== 'object') return { pct: null, text: String(p ?? '') };
  let pct = null;
  const v = p.progress ?? p.pct ?? p.percent;
  if (typeof v === 'number') pct = v <= 1 ? v * 100 : v;
  else if (p.total > 0 && typeof p.loaded === 'number') pct = 100 * p.loaded / p.total;
  return { pct, text: stageText(p) };
}

$('uploadFile').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  const status = $('uploadStatus'), bar = $('uploadProgress');
  $('uploadProgressWrap').hidden = false; bar.removeAttribute('value');
  $('uploadFile').disabled = true; $('startBtn').disabled = true;
  status.textContent = `Loading ${file.name}…`;
  try {
    const { processUpload } = await import('./upload.js');
    const capture = await processUpload(file, {
      expectedSpeakers: expectedSpeakers(),
      onProgress: p => {
        const { pct, text } = readProgress(p);
        if (pct == null) bar.removeAttribute('value'); else bar.value = Math.max(0, Math.min(100, pct));
        if (text || pct != null) status.textContent = [text, pct != null ? `${Math.round(pct)}%` : ''].filter(Boolean).join(' · ');
      },
    });
    bar.value = 100;
    await finish(capture, 'upload', status);
  } catch (err) {
    console.error(err);
    status.innerHTML = `<span class="error">${esc(err?.message || 'Could not process that file.')}</span>`;
    $('uploadProgressWrap').hidden = true;
  } finally {
    $('uploadFile').disabled = false; $('uploadFile').value = '';
    $('startBtn').disabled = !liveSupported;
  }
});

// ---------- Past sessions ----------
async function renderSessions() {
  const list = $('sessionList'), status = $('pastStatus');
  let sessions;
  try { sessions = await listSessions(); } catch (e) {
    status.innerHTML = `<span class="error">${esc(e.message)}</span>`; return;
  }
  status.textContent = sessions.length ? '' : 'No saved sessions yet.';
  list.innerHTML = sessions.map(s => {
    const date = s.createdAt ? new Date(s.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    return `<li>
      <div><a href="report.html#${encodeURIComponent(s.id)}">${esc(s.title || 'Untitled discussion')}</a>
        <div class="meta">${esc(date)} · ${clock(s.durationSec)} · ${Array.isArray(s.speakers) ? s.speakers.length : 0} speakers</div></div>
      <div class="row">
        <button class="btn small danger" type="button" data-delete="${esc(s.id)}" data-title="${esc(s.title || 'Untitled discussion')}">Delete</button>
      </div></li>`;
  }).join('');
}

$('sessionList').addEventListener('click', async e => {
  const del = e.target.closest('[data-delete]');
  try {
    if (del) {
      if (!confirm(`Delete "${del.dataset.title}" from this browser? This can't be undone.`)) return;
      await deleteSession(del.dataset.delete);
      await renderSessions();
      $('pastStatus').textContent = 'Deleted.';
    }
  } catch (err) { $('pastStatus').innerHTML = `<span class="error">${esc(err.message)}</span>`; }
});

renderSessions();
