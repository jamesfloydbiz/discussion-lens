// Sessions live in this browser only (IndexedDB). Voiceprint embeddings are kept apart and never exported.

import { analyzeRules } from './analyze.js';
import { cleanAnalysis } from './quotes.js';

export const DEFAULT_AGE_BAND = '912';   // used by the dashboard and the Claude call when a session has none
const AGE_BAND_KEYS = ['k5', '68', '912', 'adult'];
const DB_NAME = 'discussion-lens';
const DB_VERSION = 1;

// Speaker colours: mid-tone so they read on both the light and dark themes.
export const SPEAKER_COLORS = ['#3b6fb6', '#c2552d', '#2f8a5b', '#8a4fb5', '#b8862b', '#2a8a96', '#b5476f', '#6b7a32'];

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

let dbPromise = null;
function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('This browser has no IndexedDB, so sessions cannot be saved.'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('embeddings')) d.createObjectStore('embeddings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other Discussion Lens tabs and reload.'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted.'));
  });
}

export function saveSession(session) {
  return run('sessions', 'readwrite', s => s.put(session)).then(() => session);
}

export function getSession(id) {
  return run('sessions', 'readonly', s => s.get(id)).then(r => r || null);
}

// Newest first.
export async function listSessions() {
  const all = (await run('sessions', 'readonly', s => s.getAll())) || [];
  return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function deleteSession(id) {
  await run('sessions', 'readwrite', s => s.delete(id));
  await run('embeddings', 'readwrite', s => s.delete(id));
}

export function saveEmbeddings(id, { dim, data }) {
  return run('embeddings', 'readwrite', s => s.put({ dim, data }, id));
}

export function getEmbeddings(id) {
  return run('embeddings', 'readonly', s => s.get(id)).then(r => r || null);
}

export async function exportSession(id) {
  const session = await getSession(id);
  if (!session) throw new Error('Session not found.');
  return JSON.stringify(session, null, 2);
}

// Rebuilds an untrusted session (an imported file) from known fields only, with every value coerced.
// Rules analysis is recomputed; a Claude analysis is kept only after every quote passes the verbatim check.
const str = (v, max = 5000) => (v == null ? '' : String(v)).slice(0, max);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const int = v => Math.trunc(num(v));
const arr = v => (Array.isArray(v) ? v : []);
const HEX = /^#[0-9a-f]{6}$/i;

function cleanRef(r) {
  return r && typeof r === 'object' ? { turnId: str(r.turnId, 64), quote: str(r.quote, 1000) } : null;
}
function cleanScore(sc) {
  if (!sc || typeof sc !== 'object') return { value: null, label: 'Not enough evidence', basis: '', evidence: [] };
  const v = int(sc.value);
  return { value: v >= 1 && v <= 4 ? v : null, label: str(sc.label, 60), basis: str(sc.basis, 500),
    evidence: arr(sc.evidence).map(cleanRef).filter(Boolean) };
}
function cleanClaude(c, turns) {
  if (!c || typeof c !== 'object') return null;
  const people = {};
  for (const [id, p] of Object.entries(c.people && typeof c.people === 'object' ? c.people : {})) {
    if (!p || typeof p !== 'object') continue;
    const scores = {};
    for (const k of ['questions', 'reasoning', 'building', 'clarity']) scores[k] = cleanScore(p.scores?.[k]);
    const coach = x => (x && typeof x === 'object' ? { text: str(x.text, 1000), ...cleanRef(x) } : null);
    people[int(id)] = {
      scores,
      quotes: arr(p.quotes).map(q => q && typeof q === 'object' ? { ...cleanRef(q), move: str(q.move, 60), why: str(q.why, 500) } : null).filter(Boolean),
      strength: coach(p.strength), nextStep: coach(p.nextStep),
    };
  }
  const topics = arr(c.topics).filter(t => t && typeof t === 'object').map((t, i) => ({
    id: str(t.id || `topic${i + 1}`, 64), title: str(t.title, 200), summary: str(t.summary, 1000),
    keywords: arr(t.keywords).map(k => str(k, 60)), start: num(t.start), end: num(t.end),
    turnIds: arr(t.turnIds).map(x => str(x, 64)), drivers: arr(t.drivers).map(int), keyQuote: cleanRef(t.keyQuote),
  }));
  const cleaned = cleanAnalysis({ people, topics, droppedQuotes: int(c.droppedQuotes) }, turns);
  return { ...cleaned, summary: str(c.summary, 3000), model: str(c.model, 80), createdAt: str(c.createdAt, 40) };
}

export function sanitizeSession(raw) {
  const turns = [], seen = new Set();
  for (const t of arr(raw.turns)) {
    if (!t || typeof t !== 'object') continue;
    let id = str(t.id, 64) || `t${turns.length + 1}`;
    while (seen.has(id)) id += '_';
    seen.add(id);
    turns.push({ id, speaker: int(t.speaker), start: num(t.start), end: num(t.end), text: str(t.text, 20000), signals: {} });
  }
  const speakers = [], ids = new Set();
  for (const sp of arr(raw.speakers)) {
    if (!sp || typeof sp !== 'object') continue;
    const id = int(sp.id);
    if (ids.has(id)) continue;
    ids.add(id);
    speakers.push({ id, name: str(sp.name, 40).trim() || `Speaker ${id + 1}`,
      color: HEX.test(sp.color) ? sp.color : SPEAKER_COLORS[Math.abs(id) % SPEAKER_COLORS.length] });
  }
  for (const t of turns) if (!ids.has(t.speaker)) {
    ids.add(t.speaker);
    speakers.push({ id: t.speaker, name: `Speaker ${t.speaker + 1}`, color: SPEAKER_COLORS[Math.abs(t.speaker) % SPEAKER_COLORS.length] });
  }
  const created = new Date(str(raw.createdAt, 40));
  const s = {
    id: str(raw.id, 64),
    createdAt: isNaN(created) ? new Date().toISOString() : created.toISOString(),
    title: str(raw.title, 140).trim() || 'Imported discussion',
    ageBand: AGE_BAND_KEYS.includes(raw.ageBand) ? raw.ageBand : DEFAULT_AGE_BAND,
    source: ['live', 'upload', 'sample'].includes(raw.source) ? raw.source : 'upload',
    durationSec: num(raw.durationSec) || num(turns.at(-1)?.end),
    speakers,
    phrases: arr(raw.phrases).filter(p => p && typeof p === 'object').map((p, i) => ({
      id: str(p.id || `p${i + 1}`, 64), start: num(p.start), end: num(p.end), text: str(p.text, 20000),
      source: p.source === 'webspeech' ? 'webspeech' : 'whisper' })),
    windows: arr(raw.windows).filter(w => w && typeof w === 'object').map(w => ({ t: num(w.t), dur: num(w.dur) || 1.5, speaker: int(w.speaker) })),
    turns,
    analysis: { rules: null, claude: null },
  };
  s.analysis.rules = analyzeRules(s);
  s.analysis.claude = cleanClaude(raw.analysis?.claude, turns);
  return s;
}

// Accepts a JSON string (or parsed object). Keeps the id unless it is missing or taken, then gives a new one.
export async function importSession(json) {
  let raw;
  try { raw = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new Error('That file is not valid JSON.'); }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.turns) || !Array.isArray(raw.speakers)) {
    throw new Error('That file is not a Discussion Lens session.');
  }
  const s = sanitizeSession(raw);
  if (!s.turns.length) throw new Error('That session has no turns.');
  if (!s.id || s.id === 'sample' || await getSession(s.id)) s.id = newId();
  await saveSession(s);
  return s;
}
