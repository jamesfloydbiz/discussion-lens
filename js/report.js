// Dashboard: report.html#<session id> or #sample. Shows Claude results where present, rules otherwise.
// claude.js is imported only when the deep analysis runs, so the dashboard never depends on it.

import { analyzeRules } from './analyze.js';
import { AGE_BANDS, RUBRIC } from './rubric.js';
import { SPEAKER_COLORS, DEFAULT_AGE_BAND, getSession, saveSession, exportSession } from './store.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = sec => { sec = Math.max(0, Math.round(sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pctOf = share => Math.round((share > 1 ? share : share * 100) || 0);
const KEY_STORE = 'dl.anthropicKey';

let session = null;
let isSample = false;

// ---------- Load ----------
async function load() {
  const id = decodeURIComponent(location.hash.slice(1));
  const status = $('loadStatus');
  $('report').hidden = true; status.hidden = false; status.textContent = 'Loading…';
  try {
    isSample = id === 'sample';
    if (!id) throw new Error('No session chosen.');
    if (isSample) {
      const res = await fetch('data/sample-session.json');
      if (!res.ok) throw new Error('Could not load the sample.');
      session = await res.json();
    } else {
      session = await getSession(id);
      if (!session) throw new Error('This session is not saved in this browser.');
    }
    session.analysis ||= { rules: null, claude: null };
    let changed = false;
    if (!AGE_BANDS.some(b => b.key === session.ageBand)) { session.ageBand = DEFAULT_AGE_BAND; changed = true; }
    if (!session.analysis.rules) {
      session.analysis.rules = analyzeRules(session);
      changed = true;
    }
    if (changed && !isSample) await saveSession(session);
  } catch (e) {
    console.error(e);
    status.innerHTML = `<span class="error">${esc(e.message)}</span> <a href="./">Back to Discussion Lens</a>`;
    return;
  }
  status.hidden = true; $('report').hidden = false;
  $('sampleNote').hidden = !isSample;
  $('titleInput').value = session.title || 'Untitled discussion';
  renderSpeakerEdit();
  render();
}

async function persist() {
  if (isSample) return;
  try { await saveSession(session); } catch (e) { console.error(e); alert(`Could not save: ${e.message}`); }
}

// ---------- Helpers ----------
const band = () => session.ageBand;
const speakerById = id => session.speakers.find(s => s.id === id) || { id, name: `Speaker ${num(id) + 1}`, color: SPEAKER_COLORS[Math.abs(num(id)) % SPEAKER_COLORS.length] };
const nameOf = id => speakerById(id).name;
const HEX = /^#[0-9a-f]{6}$/i;
const colorOf = id => { const c = speakerById(id).color; return HEX.test(c) ? c : SPEAKER_COLORS[Math.abs(num(id)) % SPEAKER_COLORS.length]; };
const turnById = id => session.turns.find(t => t.id === id);
const active = () => session.analysis.claude || session.analysis.rules || {};
const mode = () => (session.analysis.claude ? 'claude' : 'rules');

function quoteBtn(q, color) {
  if (!q?.quote) return '';
  return `<button type="button" class="quote" ${color ? `style="--c:${esc(color)}"` : ''} data-turn="${esc(q.turnId)}" data-quote="${esc(q.quote)}"
    title="Show in transcript">“${esc(q.quote)}”</button>`;
}

// ---------- Render ----------
function render() {
  document.title = `${session.title || 'Dashboard'} · Discussion Lens`;
  renderFacts();
  renderGroup();
  renderTopics();
  renderPeople();
  renderTranscript();
  renderScience();
  renderClaudePanel();
}

function renderFacts() {
  const a = session.analysis;
  const date = session.createdAt ? new Date(session.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
  const badge = a.claude
    ? `<span class="badge claude" title="Scored by ${esc(a.claude.model || 'Claude')}">Claude analysis</span>`
    : '<span class="badge" title="Scored by wording rules">Rules estimate</span>';
  $('facts').innerHTML = `
    <span>${esc(date)}</span><span>${clock(session.durationSec)} long</span>
    <span class="row" style="gap:6px"><label for="bandSel">Age band</label>
      <select id="bandSel">${AGE_BANDS.map(b => `<option value="${esc(b.key)}"${b.key === band() ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}</select></span>
    <span>${num(session.speakers.length)} speakers</span>${badge}`;
  $('bandSel').addEventListener('change', e => { session.ageBand = e.target.value; persist(); render(); });
}

function renderSpeakerEdit() {
  $('speakerEdit').innerHTML = session.speakers.map(sp => { const s = { ...sp, id: num(sp.id), color: colorOf(sp.id) }; return `
    <div class="row">
      <label class="sr-only" for="sc-${s.id}">Colour for ${esc(s.name)}</label>
      <input id="sc-${s.id}" type="color" value="${esc(s.color)}" data-color="${s.id}">
      <label class="sr-only" for="sn-${s.id}">Name for speaker ${s.id + 1}</label>
      <input id="sn-${s.id}" type="text" value="${esc(s.name)}" maxlength="40" data-name="${s.id}">
    </div>`; }).join('');
}

$('speakerEdit').addEventListener('change', e => {
  const t = e.target, id = Number(t.dataset.name ?? t.dataset.color);
  const s = session.speakers.find(x => x.id === id);
  if (!s) return;
  if (t.dataset.name != null) s.name = t.value.trim() || `Speaker ${id + 1}`;
  else s.color = t.value;
  persist(); render();
});
$('titleInput').addEventListener('change', e => {
  session.title = e.target.value.trim() || 'Untitled discussion';
  persist(); render();
});

function renderGroup() {
  const m = session.analysis.rules?.metrics || {};
  const per = m.perSpeaker || {};
  const ids = session.speakers.map(s => s.id);
  const summary = session.analysis.claude?.summary;
  const gini = typeof m.gini === 'number' ? `Talk equity (Gini): ${m.gini.toFixed(2)}. 0 is perfectly even, 1 is one voice.` : '';
  $('summary').innerHTML = [summary && esc(summary), gini && `<span class="muted">${esc(gini)}</span>`].filter(Boolean).join('<br>');

  // Talk share bar.
  const shares = ids.map(id => ({ id, pct: pctOf(per[id]?.share) }));
  $('shareBar').innerHTML = `
    <div class="share-bar" role="img" aria-label="${esc(shares.map(s => `${nameOf(s.id)} ${s.pct}%`).join(', '))}">
      ${shares.filter(s => s.pct > 0).map(s => `<span style="--c:${esc(colorOf(s.id))};width:${s.pct}%" title="${esc(nameOf(s.id))} ${s.pct}%"></span>`).join('')}
    </div>
    <div class="legend">${shares.map(s => `<span><span class="dot" style="--c:${esc(colorOf(s.id))}"></span>${esc(nameOf(s.id))} ${s.pct}%</span>`).join('')}</div>`;

  // Timeline: topic bands coloured by main driver, then one lane per speaker.
  const dur = session.durationSec || session.turns.at(-1)?.end || 1;
  const pos = (s, e) => `left:${(100 * s / dur).toFixed(2)}%;width:${Math.max(0.3, 100 * (e - s) / dur).toFixed(2)}%`;
  const topics = Array.isArray(active().topics) ? active().topics : [];
  const topicLane = `<div class="lane"><span class="name">Topics</span><div class="track topics">
    ${topics.map((t, i) => `<span class="seg" style="${pos(t.start, t.end)};--c:${esc(colorOf(t.drivers?.[0]))}"
      title="${esc(`${i + 1}. ${t.title} (${clock(t.start)}–${clock(t.end)}), led by ${nameOf(t.drivers?.[0])}`)}">${i + 1}. ${esc(t.title)}</span>`).join('')}
    </div></div>`;
  const lanes = ids.map(id => `<div class="lane"><span class="name">${esc(nameOf(id))}</span><div class="track">
    ${session.turns.filter(t => t.speaker === id).map(t => `<span class="seg" style="${pos(t.start, t.end)};--c:${esc(colorOf(id))}"></span>`).join('')}
    </div></div>`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => `<span>${clock(f * dur)}</span>`).join('');
  $('timeline').innerHTML = `<div role="img" aria-label="Timeline of ${num(topics.length)} topics and when each person spoke">${topicLane}${lanes}</div><div class="axis" aria-hidden="true">${ticks}</div>`;

  // Who-responds-to-whom grid.
  const rt = m.respondsTo || {};
  let max = 0;
  for (const a of ids) for (const b of ids) max = Math.max(max, num(rt[a]?.[b]));
  $('respondsGrid').innerHTML = `<table class="grid">
    <thead><tr><th scope="col"><span class="sr-only">Spoke, then</span></th>${ids.map(id => `<th scope="col">${esc(nameOf(id))}</th>`).join('')}</tr></thead>
    <tbody>${ids.map(a => `<tr><th scope="row"><span class="dot" style="--c:${esc(colorOf(a))}"></span>${esc(nameOf(a))}</th>
      ${ids.map(b => { const n = num(rt[a]?.[b]); const mix = max ? Math.round(55 * n / max) : 0;
        return `<td style="background:color-mix(in srgb, var(--accent) ${mix}%, transparent)" aria-label="${n} times ${esc(nameOf(b))} spoke right after ${esc(nameOf(a))}">${n || ''}</td>`; }).join('')}
    </tr>`).join('')}</tbody></table>`;
}

function renderTopics() {
  const topics = Array.isArray(active().topics) ? active().topics : [];
  if (!topics.length) { $('topics').innerHTML = '<li class="muted">No topics found.</li>'; return; }
  $('topics').innerHTML = topics.map((t, i) => {
    const who = [...new Set((t.turnIds || []).map(id => turnById(id)?.speaker).filter(s => s != null))];
    const contributors = (who.length ? who : t.drivers || []);
    const about = t.summary || (t.keywords?.length ? `Keywords: ${t.keywords.join(', ')}` : '');
    return `<li>
      <div class="span">${clock(t.start)}–${clock(t.end)}</div>
      <h3>${i + 1}. ${esc(t.title)}</h3>
      ${about ? `<p class="muted">${esc(about)}</p>` : ''}
      <div class="legend" style="margin:0 0 8px">${contributors.map(id => `<span><span class="dot" style="--c:${esc(colorOf(id))}"></span>${esc(nameOf(id))}${t.drivers?.[0] === id ? ' (led)' : ''}</span>`).join('')}</div>
      ${quoteBtn(t.keyQuote, colorOf(turnById(t.keyQuote?.turnId)?.speaker ?? t.drivers?.[0]))}
    </li>`;
  }).join('');
}

function scoreBlock(dim, score) {
  const v = [1, 2, 3, 4].includes(Number(score?.value)) ? Number(score.value) : null;
  const anchors = dim.anchors?.[band()] || [];
  const steps = [1, 2, 3, 4].map(n => `<span class="${v != null && n <= v ? 'on' : ''}"></span>`).join('');
  let label, detail;
  if (v == null) {
    label = mode() === 'rules' && dim.key === 'clarity' ? 'Claude analysis only' : 'Not enough evidence';
    detail = score?.basis || '';
  } else {
    label = `${v}/4${score.label ? ` · ${score.label}` : ''}`;
    detail = anchors[v - 1] || score.basis || '';
  }
  const ev = score?.evidence?.[0];
  return `<div>
    <div class="dim-head"><strong>${esc(dim.name)}</strong><span>${esc(label)}</span></div>
    <div class="steps${v == null ? ' none' : ''}" role="img" aria-label="${esc(dim.name)}: ${esc(label)}">${steps}</div>
    ${detail ? `<p class="anchor">${esc(detail)}</p>` : ''}
    ${v != null && score.basis && detail !== score.basis ? `<p class="anchor">${esc(score.basis)}</p>` : ''}
    ${ev ? `<p class="anchor">e.g. <button type="button" class="linkish" data-turn="${esc(ev.turnId)}" data-quote="${esc(ev.quote)}">“${esc(ev.quote)}”</button></p>` : ''}
  </div>`;
}

function coach(title, item) {
  if (!item?.text) return '';
  return `<div><h4>${esc(title)}</h4><p>${esc(item.text)}</p>
    ${item.quote ? `<button type="button" class="linkish" data-turn="${esc(item.turnId)}" data-quote="${esc(item.quote)}">“${esc(item.quote)}”</button>` : ''}</div>`;
}

function renderPeople() {
  const rules = session.analysis.rules || {}, claude = session.analysis.claude;
  const per = rules.metrics?.perSpeaker || {};
  const ids = session.speakers.map(s => s.id).filter(id => session.turns.some(t => t.speaker === id));
  $('people').innerHTML = ids.map(id => {
    const m = per[id] || {};
    const p = claude?.people?.[id] || rules.people?.[id] || {};
    const c = colorOf(id);
    const quotes = (p.quotes || []).slice(0, 3);
    return `<article class="card person" style="--c:${esc(c)}" aria-labelledby="pname-${num(id)}">
      <h3 id="pname-${num(id)}"><span class="dot" style="--c:${esc(c)}"></span>${esc(nameOf(id))}</h3>
      <dl class="stats">
        <div><dt>Talk</dt><dd>${pctOf(m.share)}%</dd></div>
        <div><dt>Turns</dt><dd>${num(m.turns)}</dd></div>
        <div><dt>Questions</dt><dd>${num(m.deepQuestions)}/${num(m.questions)} <small style="font-size:.7rem;font-weight:400">deep</small></dd></div>
      </dl>
      <div class="rubric">${RUBRIC.map(dim => scoreBlock(dim, p.scores?.[dim.key])).join('')}</div>
      ${quotes.length ? `<h4 class="sr-only">Quotes</h4><div class="quotes">${quotes.map(q => `<div>
        ${quoteBtn(q, c)}
        <p class="why">${q.move ? `<span class="tag">${esc(q.move)}</span> ` : ''}${esc(q.why || '')}</p></div>`).join('')}</div>` : ''}
      ${claude && (p.strength || p.nextStep) ? `<div class="coach">${coach('Strength', p.strength)}${coach('Next step', p.nextStep)}</div>` : ''}
    </article>`;
  }).join('');
}

function tagChips(tags) {
  if (!tags) return '';
  const chips = [
    ...(tags.questions || []).map(q => `<span class="tag${q.deep ? ' deep' : ''}">${q.deep ? 'deep question' : 'question'}: ${esc(q.type)}</span>`),
    ...(tags.reasoning || []).map(r => `<span class="tag">${esc(r)}</span>`),
    ...(tags.buildsOn?.explicit || tags.buildsOn?.uptakeFrom ? ['<span class="tag">builds on</span>'] : []),
  ];
  return chips.length ? `<div class="tags">${chips.join('')}</div>` : '';
}

function renderTranscript() {
  const tags = session.analysis.rules?.turnTags || {};
  $('turnCount').textContent = `(${session.turns.length} turns)`;
  $('transcript').innerHTML = session.turns.map(t => `
    <div class="turn" id="turn-${esc(t.id)}" tabindex="-1">
      <span class="time">${clock(t.start)}</span>
      <div><span class="who" style="--c:${esc(colorOf(t.speaker))}">${esc(nameOf(t.speaker))}</span>
        <p class="text">${esc(t.text)}</p>${tagChips(tags[t.id])}</div>
    </div>`).join('');
}

function renderScience() {
  $('science').innerHTML = `<dl>${RUBRIC.map(dim => `
    <dt>${esc(dim.name)}</dt>
    <dd>
      <ol>${(dim.anchors?.[band()] || []).map(a => `<li>${esc(a)}</li>`).join('')}</ol>
      ${dim.basis?.length ? `<ul>${dim.basis.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    </dd>`).join('')}</dl>`;
}

// ---------- Quote → transcript ----------
function showInTranscript(turnId, quote) {
  const el = document.getElementById(`turn-${turnId}`);
  if (!el) return;
  $('transcriptBox').open = true;
  document.querySelectorAll('#transcript mark').forEach(m => m.replaceWith(m.textContent));
  const p = el.querySelector('.text');
  const i = quote ? p.textContent.indexOf(quote) : -1;
  if (i >= 0) {
    const txt = p.textContent;
    p.innerHTML = `${esc(txt.slice(0, i))}<mark>${esc(quote)}</mark>${esc(txt.slice(i + quote.length))}`;
  }
  el.classList.add('flash');
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  el.focus({ preventScroll: true });
  setTimeout(() => el.classList.remove('flash'), 1600);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-turn]');
  if (b) showInTranscript(b.dataset.turn, b.dataset.quote);
});

// ---------- Claude ----------
function keyGet() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } }
function keySet(v) { try { localStorage.setItem(KEY_STORE, v); } catch { /* storage blocked */ } }
function keyForget() { try { localStorage.removeItem(KEY_STORE); } catch { /* storage blocked */ } }

function renderClaudePanel() {
  const c = session.analysis.claude;
  $('runClaude').textContent = c ? 'Run again' : 'Run deep analysis';
  if (c && !$('claudeStatus').dataset.busy) {
    const when = c.createdAt ? new Date(c.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    $('claudeStatus').textContent = `Showing Claude analysis${c.model ? ` (${c.model})` : ''}${when ? `, ${when}` : ''}.${c.droppedQuotes ? ` ${c.droppedQuotes} quotes dropped: not found in the transcript.` : ''}`;
  }
}

function readProgress(p) {
  if (typeof p === 'number') return { pct: p <= 1 ? p * 100 : p, text: '' };
  if (!p || typeof p !== 'object') return { pct: null, text: String(p ?? '') };
  const v = p.progress ?? p.pct ?? p.percent;
  return { pct: typeof v === 'number' ? (v <= 1 ? v * 100 : v) : null, text: p.message || p.stage || p.status || '' };
}

$('apiKey').value = keyGet();
$('forgetKey').addEventListener('click', () => {
  keyForget(); $('apiKey').value = '';
  $('claudeStatus').textContent = 'Key removed from this browser.';
});
$('claudeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const key = $('apiKey').value.trim();
  const status = $('claudeStatus'), bar = $('claudeProgress'), btn = $('runClaude');
  if (!key) { status.innerHTML = '<span class="error">Enter your Anthropic API key first.</span>'; $('apiKey').focus(); return; }
  keySet(key);
  btn.disabled = true; status.dataset.busy = '1'; bar.hidden = false; bar.removeAttribute('value');
  status.textContent = 'Starting…';
  try {
    const { analyzeWithClaude } = await import('./claude.js');
    const result = await analyzeWithClaude(session, key, {
      onProgress: p => {
        const { pct, text } = readProgress(p);
        if (pct == null) bar.removeAttribute('value'); else bar.value = Math.max(0, Math.min(100, pct));
        if (text) status.textContent = text;
      },
    });
    session.analysis.claude = result;
    await persist();
    delete status.dataset.busy;
    render();
    if (isSample) status.textContent += ' Not saved: this is the sample.';
  } catch (err) {
    console.error(err);
    delete status.dataset.busy;
    status.innerHTML = `<span class="error">${esc(err?.message || 'Deep analysis failed.')}</span>`;
  } finally {
    btn.disabled = false; bar.hidden = true;
  }
});

// ---------- Export / print ----------
$('exportBtn').addEventListener('click', async () => {
  try {
    const json = isSample ? JSON.stringify(session, null, 2) : await exportSession(session.id);
    const name = (String(session.title || 'discussion').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'discussion') + '.json';
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { alert(`Export failed: ${e.message}`); }
});
$('printBtn').addEventListener('click', () => print());
let closedForPrint = [];
addEventListener('beforeprint', () => {
  closedForPrint = [...document.querySelectorAll('details:not([open])')];
  closedForPrint.forEach(d => { d.open = true; });
});
addEventListener('afterprint', () => { closedForPrint.forEach(d => { d.open = false; }); closedForPrint = []; });

addEventListener('hashchange', load);
load();
