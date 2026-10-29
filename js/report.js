// Dashboard: report.html#<session id> or #sample. Names and merges speakers, then shows each person's measures.

import { analyzeRules } from './analyze.js';
import { AGE_BANDS, RUBRIC } from './rubric.js';
import { MERGE_GAP_SEC } from './turns.js';
import { SPEAKER_COLORS, DEFAULT_AGE_BAND, getSession, saveSession } from './store.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = sec => { sec = Math.max(0, Math.round(sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pctOf = share => Math.round((share > 1 ? share : share * 100) || 0);
// Clarity needs a reader of the whole discussion; wording rules can't score it, so it isn't shown.
const DIMS = RUBRIC.filter(d => d.key !== 'clarity');

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
  renderPeople();
  renderTranscript();
}

function renderFacts() {
  const date = session.createdAt ? new Date(session.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
  $('facts').innerHTML = `<span>${esc(date)}</span><span>${clock(session.durationSec)} long</span><span>${num(session.speakers.length)} speakers</span>`;
}

function renderSpeakerEdit() {
  $('speakerEdit').innerHTML = session.speakers.map(sp => { const s = { ...sp, id: num(sp.id), color: colorOf(sp.id) }; return `
    <div class="row">
      <label class="sr-only" for="sc-${s.id}">Colour for ${esc(s.name)}</label>
      <input id="sc-${s.id}" type="color" value="${esc(s.color)}" data-color="${s.id}">
      <label class="sr-only" for="sn-${s.id}">Name for speaker ${s.id + 1}</label>
      <input id="sn-${s.id}" type="text" value="${esc(s.name)}" maxlength="40" data-name="${s.id}">
      ${session.speakers.length > 1 ? `<label class="sr-only" for="sm-${s.id}">Merge ${esc(s.name)} into</label>
      <select id="sm-${s.id}" data-merge="${s.id}"><option value="">Merge into…</option>
        ${session.speakers.filter(o => o.id !== sp.id).map(o => `<option value="${num(o.id)}">${esc(o.name)}</option>`).join('')}</select>` : ''}
    </div>`; }).join('');
}

// One person split into two groups: give `from`'s speech to `into`, join their back-to-back turns, rescore.
function mergeSpeakers(from, into) {
  for (const w of session.windows || []) if (w.speaker === from) w.speaker = into;
  const turns = [];
  for (const t of session.turns) {
    const sp = t.speaker === from ? into : t.speaker, last = turns.at(-1);
    if (last && last.speaker === sp && t.start - last.end < MERGE_GAP_SEC) { last.end = Math.max(last.end, t.end); last.text += ' ' + t.text; }
    else turns.push({ ...t, speaker: sp });
  }
  session.turns = turns.map((t, i) => ({ ...t, id: 't' + (i + 1) }));
  session.speakers = session.speakers.filter(s => s.id !== from);
  session.analysis = { rules: analyzeRules(session), claude: null };
}

$('speakerEdit').addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.merge != null) {
    const from = Number(t.dataset.merge), into = Number(t.value);
    if (t.value === '' || !confirm(`Merge ${nameOf(from)} into ${nameOf(into)}? Their speech becomes one person.`)) { t.value = ''; return; }
    mergeSpeakers(from, into);
    persist(); renderSpeakerEdit(); render();
    return;
  }
  const id = Number(t.dataset.name ?? t.dataset.color);
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
  const lanes = ids.map(id => `<div class="lane"><span class="name">${esc(nameOf(id))}</span><div class="track">
    ${session.turns.filter(t => t.speaker === id).map(t => `<span class="seg" style="${pos(t.start, t.end)};--c:${esc(colorOf(id))}"></span>`).join('')}
    </div></div>`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => `<span>${clock(f * dur)}</span>`).join('');
  $('timeline').innerHTML = `<div role="img" aria-label="When each person spoke">${lanes}</div><div class="axis" aria-hidden="true">${ticks}</div>`;

}

function scoreBlock(dim, score) {
  const v = [1, 2, 3, 4].includes(Number(score?.value)) ? Number(score.value) : null;
  const anchors = dim.anchors?.[band()] || [];
  const steps = [1, 2, 3, 4].map(n => `<span class="${v != null && n <= v ? 'on' : ''}"></span>`).join('');
  let label, detail;
  if (v == null) {
    label = 'Not enough evidence';
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

function renderPeople() {
  const rules = session.analysis.rules || {};
  const per = rules.metrics?.perSpeaker || {};
  const ids = session.speakers.map(s => s.id).filter(id => session.turns.some(t => t.speaker === id));
  $('people').innerHTML = ids.map(id => {
    const m = per[id] || {};
    const p = rules.people?.[id] || {};
    const c = colorOf(id);
    const quotes = (p.quotes || []).slice(0, 3);
    return `<article class="card person" style="--c:${esc(c)}" aria-labelledby="pname-${num(id)}">
      <h3 id="pname-${num(id)}"><span class="dot" style="--c:${esc(c)}"></span>${esc(nameOf(id))}</h3>
      <dl class="stats">
        <div><dt>Talk</dt><dd>${pctOf(m.share)}%</dd></div>
        <div><dt>Turns</dt><dd>${num(m.turns)}</dd></div>
        <div><dt>Questions</dt><dd>${num(m.deepQuestions)}/${num(m.questions)} <small style="font-size:.7rem;font-weight:400">deep</small></dd></div>
      </dl>
      <div class="rubric">${DIMS.map(dim => scoreBlock(dim, p.scores?.[dim.key])).join('')}</div>
      ${quotes.length ? `<h4 class="sr-only">Quotes</h4><div class="quotes">${quotes.map(q => `<div>
        ${quoteBtn(q, c)}
        <p class="why">${q.move ? `<span class="tag">${esc(q.move)}</span> ` : ''}${esc(q.why || '')}</p></div>`).join('')}</div>` : ''}
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

addEventListener('hashchange', load);
load();
