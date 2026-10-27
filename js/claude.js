// Claude analysis with the visitor's own API key, called straight from the browser.
// Structured JSON via output_config.format (json_schema); every quote is checked by cleanAnalysis.
// The key is only ever put in the request header: never logged, stored, or put in an error.

import { RUBRIC, AGE_BANDS, levelLabel } from './rubric.js';
import { cleanAnalysis } from './quotes.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const EFFORT_MODELS = /opus|fable|mythos|sonnet-5|sonnet-4-6|haiku-5/;
const DIMENSIONS = ['questions', 'reasoning', 'building', 'clarity'];

export class ClaudeError extends Error {
  constructor(message, { status = 0, type = 'error', retryable = false } = {}) {
    super(message); this.name = 'ClaudeError'; this.status = status; this.type = type; this.retryable = retryable;
  }
}

// --- prompt ---

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const mmss = `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

const nameOf = session => {
  const m = new Map((session.speakers || []).map(s => [s.id, s.name]));
  return id => m.get(id) || `Speaker ${id + 1}`;
};

// One line per turn: [t12 | Maya | 03:21] text
export function transcriptLines(session) {
  const name = nameOf(session);
  return (session.turns || []).map(t => `[${t.id} | ${name(t.speaker)} | ${fmtTime(t.start)}] ${t.text.replace(/\s+/g, ' ').trim()}`).join('\n');
}

export function rubricText(ageBand) {
  const band = AGE_BANDS.find(b => b.key === ageBand) || AGE_BANDS[3];
  return RUBRIC.map(r => {
    const a = r.anchors[band.key];
    return `## ${r.key}: ${r.name}\nBasis: ${r.basis.join(' ')}\n` + a.map((x, i) => `${i + 1} = ${x}`).join('\n');
  }).join('\n\n');
}

export function buildPrompt(session) {
  const band = AGE_BANDS.find(b => b.key === session.ageBand) || AGE_BANDS[3];
  const system = `You analyze transcripts of group discussions for a teacher or facilitator. You give each person a fair, evidence-based picture of their participation and the quality of their thinking.

The transcript comes from automatic speech recognition. Punctuation may be missing, some words may be misheard, and a few turns may carry the wrong speaker. Judge the thinking, not grammar or transcription errors.

Scoring. Score every speaker on the four dimensions below, 1 to 4, using the anchors for the ${band.label} age band. Judge against that age band, not adult standards. Use null when the transcript gives too little evidence, for example null for question quality if the person asked no questions. A null is better than a guess.
- questions: classify each question in context (clarification, evidence, assumption, viewpoint, implication, causal are deep; factual recall and yes/no are shallow) and weigh whether it is authentic, meaning the asker does not already know the answer.
- reasoning: look for claim, grounds, warrant and qualifier, and for counterarguments raised and answered.
- building: real uptake of another person's idea, not just taking a turn on the same topic.
- clarity: clear, precise, relevant contributions.

Quotes. Copy every quote exactly, character for character, from one turn, and set turnId to that turn's id (the t-number in brackets). Never paraphrase, fix grammar, add punctuation, join pieces with "...", or span two turns. Keep each quote short: one sentence or clause, under 30 words. Score evidence, quality quotes, strength and next step must quote that person's own turns. Quotes that do not match the transcript are removed automatically, and a score whose evidence is all removed becomes null.

For each speaker give: the four scores, each with a one-line basis and up to 3 evidence quotes; 2 or 3 quality quotes showing their best thinking moves, each with a short move tag (such as "Asks for evidence", "Counterargument", "Builds on Maya") and a one-line why; one strength and one next step, each tied to a quote of theirs. Write the strength and next step in plain, specific, encouraging words the person could read themselves.

Topics. Split the discussion into its topics, in order. Each topic is a contiguous run of turns from startTurn to endTurn, with a short title, 3 to 5 keywords, a one-sentence summary, the speaker ids who drove it, and its strongest question or claim as keyQuote.

Finally, write a 2 to 3 sentence summary of the whole discussion.

# Rubric (${band.label})

${rubricText(band.key)}`;
  const speakers = (session.speakers || []).map(s => `${s.id} = ${s.name}`).join(', ');
  const user = `Speaker ids: ${speakers}\n\nTranscript (each line is [turn id | speaker | mm:ss] text):\n\n${transcriptLines(session)}`;
  return { system, user };
}

// --- output schema (structured outputs; objects need additionalProperties: false) ---

const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: 'string' };
const ref = obj({ turnId: str, quote: str });
const scoreSchema = obj({
  value: { anyOf: [{ type: 'integer', enum: [1, 2, 3, 4] }, { type: 'null' }] },
  basis: str,
  evidence: { type: 'array', items: ref },
});

export const SCHEMA = obj({
  summary: str,
  topics: { type: 'array', items: obj({
    title: str, summary: str, keywords: { type: 'array', items: str },
    startTurn: str, endTurn: str, drivers: { type: 'array', items: { type: 'integer' } }, keyQuote: ref,
  }) },
  people: { type: 'array', items: obj({
    speaker: { type: 'integer' },
    scores: obj(Object.fromEntries(DIMENSIONS.map(d => [d, scoreSchema]))),
    quotes: { type: 'array', items: obj({ turnId: str, quote: str, move: str, why: str }) },
    strength: obj({ text: str, turnId: str, quote: str }),
    nextStep: obj({ text: str, turnId: str, quote: str }),
  }) },
});

// --- request ---

export function buildRequest(session, { model = DEFAULT_MODEL, effort = 'high' } = {}) {
  const { system, user } = buildPrompt(session);
  const body = {
    model, max_tokens: 64000, stream: true, system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  };
  if (EFFORT_MODELS.test(model)) body.output_config.effort = effort;
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': API_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (FALLBACK_MODELS.has(model)) { body.fallbacks = 'default'; headers['anthropic-beta'] = FALLBACK_BETA; }
  return { body, headers };
}

// Clear message for an API error; never includes the key.
export function errorFor(status, type, message, retryAfter) {
  const wait = retryAfter ? ` Try again in ${retryAfter} s.` : ' Try again in a minute.';
  if (status === 401 || type === 'authentication_error') return new ClaudeError('That API key was rejected. Check it at console.anthropic.com and paste it again.', { status, type });
  if (status === 403 || type === 'permission_error') return new ClaudeError('This API key isn\'t allowed to use that model.', { status, type });
  if (status === 402 || type === 'billing_error') return new ClaudeError('Billing problem on this key: out of credit or over its spend limit.', { status, type });
  if (status === 404 || type === 'not_found_error') return new ClaudeError(`Model not found for this key. ${message || ''}`.trim(), { status, type });
  if (status === 413 || type === 'request_too_large') return new ClaudeError('This transcript is too long to send in one request.', { status, type });
  if (status === 429 || type === 'rate_limit_error') return new ClaudeError(`Rate limit reached on this key.${wait}`, { status, type, retryable: true });
  if (status === 529 || type === 'overloaded_error') return new ClaudeError(`Claude is overloaded right now.${wait}`, { status, type, retryable: true });
  if (status >= 500 || type === 'api_error') return new ClaudeError(`Claude API error (${status || type}).${wait}`, { status, type, retryable: true });
  return new ClaudeError(`Request rejected: ${message || `HTTP ${status}`}`, { status, type });
}

async function readError(res) {
  let type = '', message = '';
  try { const j = await res.json(); type = j?.error?.type || ''; message = j?.error?.message || ''; } catch { /* not JSON */ }
  return errorFor(res.status, type, message, res.headers.get('retry-after'));
}

// Read a streamed (SSE) or plain JSON Messages response → { text, segments, stopReason, model }.
// A refusal fallback (server-side `fallbacks`) marks each model switch with a `fallback` content
// block; streamed text before it is never retracted. `segments` holds the text between switches,
// so the caller can use the joined text or only the final model's text, whichever parses.
export async function readMessage(res, onProgress = () => {}) {
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('event-stream')) {
    const m = await res.json();
    const segments = [''];
    for (const b of m.content || []) {
      if (b.type === 'fallback') segments.push('');
      else if (b.type === 'text') segments[segments.length - 1] += b.text;
    }
    return { text: segments.join(''), segments, stopReason: m.stop_reason, model: m.model };
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', stopReason = null, model = null;
  const segments = [''];
  const chars = () => segments.reduce((a, x) => a + x.length, 0);
  const handle = (data) => {
    const e = JSON.parse(data);
    if (e.type === 'message_start') model = e.message?.model || model;
    else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      segments[segments.length - 1] += e.delta.text; onProgress({ stage: 'writing', chars: chars() });
    } else if (e.type === 'content_block_start' && e.content_block?.type === 'fallback') {
      segments.push(''); model = e.content_block.to?.model || model;
      onProgress({ stage: 'fallback', model });
    } else if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') onProgress({ stage: 'thinking', chars: chars() });
    else if (e.type === 'message_delta') stopReason = e.delta?.stop_reason || stopReason;
    else if (e.type === 'error') throw errorFor(0, e.error?.type, e.error?.message);
  };
  for (;;) {
    const { value, done } = await reader.read();
    buf += dec.decode(value || new Uint8Array(), { stream: !done });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (data) handle(data);
    }
    if (done) break;
  }
  return { text: segments.join(''), segments, stopReason, model };
}

// JSON from the reply: the whole text, or else only the text after the last model switch.
export function parseReply(msg) {
  const tries = [msg.text, msg.segments?.[msg.segments.length - 1]].filter((x, i, a) => x && a.indexOf(x) === i);
  for (const t of tries) { try { return JSON.parse(t); } catch { /* try the next */ } }
  return undefined;
}

// --- raw Claude JSON → ClaudeAnalysis ---

export function toAnalysis(raw, session, model) {
  const turns = session.turns || [];
  const ids = new Set((session.speakers || []).map(s => s.id));
  turns.forEach(t => ids.add(t.speaker));
  const idx = new Map(turns.map((t, i) => [t.id, i]));
  const people = {};
  for (const p of raw.people || []) {
    if (!ids.has(p.speaker)) continue;
    const scores = {};
    for (const d of DIMENSIONS) {
      const s = p.scores?.[d] || {};
      const value = [1, 2, 3, 4].includes(s.value) ? s.value : null;
      scores[d] = { value, label: levelLabel(value), basis: s.basis || '', evidence: (s.evidence || []).slice(0, 3) };
    }
    people[p.speaker] = { scores, quotes: (p.quotes || []).slice(0, 3), strength: p.strength || null, nextStep: p.nextStep || null };
  }
  const topics = (raw.topics || []).map((t, i) => {
    let a = idx.get(t.startTurn), b = idx.get(t.endTurn);
    if (a == null) a = 0;
    if (b == null || b < a) b = a;
    const span = turns.slice(a, b + 1);
    return {
      id: `topic${i + 1}`, title: t.title, summary: t.summary, keywords: t.keywords || [],
      start: span[0]?.start ?? 0, end: span[span.length - 1]?.end ?? 0, turnIds: span.map(x => x.id),
      drivers: (t.drivers || []).filter(d => ids.has(d)), keyQuote: t.keyQuote || null,
    };
  });
  return cleanAnalysis({ people, topics, summary: raw.summary || '', model, createdAt: new Date().toISOString(), droppedQuotes: 0 }, turns);
}

// --- main entry ---

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function analyzeWithClaude(session, apiKey, {
  model = DEFAULT_MODEL, effort = 'high', onProgress = () => {}, fetch: doFetch = globalThis.fetch.bind(globalThis),
  maxRetries = 2, retryDelayMs = 4000, signal,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) throw new ClaudeError('Add your Anthropic API key first.', { type: 'no_key' });
  if (!session?.turns?.length) throw new ClaudeError('This session has no transcript to analyze.', { type: 'empty' });
  const { body, headers } = buildRequest(session, { model, effort });
  let res;
  for (let attempt = 0; ; attempt++) {
    onProgress({ stage: 'sending', attempt });
    try {
      res = await doFetch(API_URL, { method: 'POST', headers: { ...headers, 'x-api-key': apiKey.trim() }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new ClaudeError('Couldn\'t reach the Claude API. Check your connection, or whether an extension is blocking it.', { type: 'network', retryable: true });
    }
    if (res.ok) break;
    const err = await readError(res);
    if (!err.retryable || attempt >= maxRetries) throw err;
    const ra = Number(res.headers.get('retry-after'));
    onProgress({ stage: 'retrying', message: err.message });
    await sleep(ra > 0 ? ra * 1000 : retryDelayMs * (attempt + 1));
  }
  const msg = await readMessage(res, onProgress);
  if (msg.stopReason === 'refusal') throw new ClaudeError('Claude declined to analyze this transcript.', { type: 'refusal' });
  if (msg.stopReason === 'max_tokens') throw new ClaudeError('Claude\'s answer was cut off before it finished. Try a shorter session.', { type: 'max_tokens' });
  const raw = parseReply(msg);
  if (raw === undefined) throw new ClaudeError('Claude\'s answer wasn\'t valid JSON. Try again.', { type: 'bad_json' });
  onProgress({ stage: 'checking' });
  const analysis = toAnalysis(raw, session, msg.model || model);
  onProgress({ stage: 'done', droppedQuotes: analysis.droppedQuotes });
  return analysis;
}
