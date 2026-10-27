// Quote checking: every quote shown must be a verbatim span of a turn's text.
// Matching ignores case, punctuation and apostrophes (speech-to-text is inconsistent there),
// but what we keep is always the exact substring from the transcript.

import { splitSentences, wordCount } from './rules.js';

const MIN_WORDS = 8;    // merge shorter sentences with a neighbour
const MAX_WORDS = 40;

// Lowercased letters/digits with single spaces, plus a map back to original indices.
function fold(text) {
  let out = '', map = [], space = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i].toLowerCase();
    if (/[’‘'`]/.test(c)) continue;
    if (/[a-z0-9À-ɏ]/.test(c)) { out += c; map.push(i); space = false; }
    else if (!space) { out += ' '; map.push(i); space = true; }
  }
  if (out.endsWith(' ')) { out = out.slice(0, -1); map.pop(); }
  return { out, map };
}

// Exact substring of turnText that the quote matches, or null if it's not in the turn.
export function verifyQuote(quote, turnText) {
  if (typeof quote !== 'string' || typeof turnText !== 'string') return null;
  const q = fold(quote).out;
  if (q.length < 3) return null;
  const t = fold(turnText);
  let i = t.out.indexOf(q);
  while (i >= 0) {
    const end = i + q.length;
    const okStart = i === 0 || t.out[i - 1] === ' ';
    const okEnd = end === t.out.length || t.out[end] === ' ';
    if (okStart && okEnd) return turnText.slice(t.map[i], t.map[end - 1] + 1);
    i = t.out.indexOf(q, i + 1);
  }
  return null;
}

// Trim a span to at most `max` words, keeping the words around `focus` (a char index).
export function clipWords(text, focus = 0, max = MAX_WORDS) {
  const words = [...text.matchAll(/\S+/g)];
  if (words.length <= max) return text.trim();
  let k = words.findIndex(w => w.index + w[0].length > focus);
  if (k < 0) k = 0;
  const a = Math.max(0, Math.min(k - Math.floor(max / 3), words.length - max));
  const b = a + max - 1;
  return text.slice(words[a].index, words[b].index + words[b][0].length);
}

// Quote for sentence i of a turn: the whole sentence, merged with its neighbours while under
// MIN_WORDS (next one first), never past MAX_WORDS. Always an exact substring of `text`.
export function quoteSpan(text, i, sens = splitSentences(text), min = MIN_WORDS, max = MAX_WORDS) {
  if (!sens.length) return clipWords(text);
  let a = i, b = i;
  const len = (x, y) => wordCount(text.slice(sens[x].start, sens[y].end));
  while (len(a, b) < min) {
    if (b + 1 < sens.length && len(a, b + 1) <= max) b++;
    else if (a > 0 && len(a - 1, b) <= max) a--;
    else break;
  }
  return clipWords(text.slice(sens[a].start, sens[b].end), sens[i].start - sens[a].start, max);
}

// Best quote from a turn: the sentence chosen by `score(sentence)` (default: longest), as a span.
export function bestSentence(text, score = s => wordCount(s)) {
  const sens = splitSentences(text);
  if (!sens.length) return clipWords(text);
  let best = 0, bs = -Infinity;
  sens.forEach((s, i) => { const v = score(s.text); if (v > bs) { bs = v; best = i; } });
  return quoteSpan(text, best, sens);
}

// Check one { turnId, quote } against the turns. If the quote isn't in the named turn,
// accept it from another allowed turn when it appears in exactly one. Returns fixed ref or null.
function checkRef(ref, byId, allowed) {
  if (!ref || typeof ref.quote !== 'string') return null;
  const own = byId.get(ref.turnId);
  if (own && allowed.includes(own)) {
    const hit = verifyQuote(ref.quote, own.text);
    if (hit) return { ...ref, quote: hit };
  }
  const hits = allowed.map(t => [t, verifyQuote(ref.quote, t.text)]).filter(([, h]) => h);
  return hits.length === 1 ? { ...ref, turnId: hits[0][0].id, quote: hits[0][1] } : null;
}

// Strip every quote that isn't verbatim. A score whose evidence all fails (or that cites none)
// drops to value null. Returns a new analysis with `droppedQuotes` = number removed.
export function cleanAnalysis(analysis, turns) {
  const byId = new Map(turns.map(t => [t.id, t]));
  let dropped = 0;
  const check = (ref, allowed) => { const r = checkRef(ref, byId, allowed); if (!r && ref) dropped++; return r; };
  const people = {};
  for (const [id, p] of Object.entries(analysis.people || {})) {
    const mine = turns.filter(t => String(t.speaker) === String(id));
    const scores = {};
    for (const [k, sc] of Object.entries(p.scores || {})) {
      const evidence = (sc.evidence || []).map(e => check(e, mine)).filter(Boolean);
      const keep = sc.value == null || evidence.length > 0;
      scores[k] = keep ? { ...sc, evidence } : { ...sc, value: null, label: 'Not enough evidence', evidence: [] };
    }
    const out = { ...p, scores, quotes: (p.quotes || []).map(q => check(q, mine)).filter(Boolean) };
    for (const key of ['strength', 'nextStep']) if (key in p) out[key] = p[key] ? check(p[key], mine) : null;
    people[id] = out;
  }
  const topics = (analysis.topics || []).map(t => {
    const inTopic = turns.filter(x => (t.turnIds || []).includes(x.id));
    return { ...t, keyQuote: t.keyQuote ? check(t.keyQuote, inTopic.length ? inTopic : turns) : null };
  });
  return { ...analysis, people, topics, droppedQuotes: (analysis.droppedQuotes || 0) + dropped };
}
