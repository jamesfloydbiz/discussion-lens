// Topic segmentation, TextTiling-style (Hearst 1997): cut the talk into ~60 s blocks of content
// words, compare neighbouring blocks, and start a new topic where similarity dips deepest.

import { norm, STOPWORDS, stem, splitSentences, isQuestion, classifyQuestion, reasoningTags } from './rules.js';
import { quoteSpan } from './quotes.js';

// Stemmed content words with the surface form each came from.
function tokens(text) {
  return (norm(text).match(/[a-z][a-z']+/g) || [])
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .map(w => ({ w: stem(w), surface: w.replace(/'s$/, '') }));
}

function counts(turns) {
  const m = new Map();
  for (const t of turns) for (const { w } of tokens(t.text)) m.set(w, (m.get(w) || 0) + 1);
  return m;
}

function cos(a, b) {
  let s = 0, na = 0, nb = 0;
  for (const [w, x] of a) { na += x * x; if (b.has(w)) s += x * b.get(w); }
  for (const x of b.values()) nb += x * x;
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}

// Block length: 60 s for long talks; shorter (down to 20 s) so short talks still get ~6 blocks.
export function blockSeconds(durationSec) {
  return durationSec >= 360 ? 60 : Math.max(20, durationSec / 6);
}

// Indices (into blocks) where a new topic starts.
export function boundaries(blocks, k = 2) {
  if (blocks.length < 3) return [];
  k = Math.min(k, Math.floor(blocks.length / 2));
  const gaps = [];
  for (let g = 1; g < blocks.length; g++) {
    const left = counts(blocks.slice(Math.max(0, g - k), g).flat());
    const right = counts(blocks.slice(g, g + k).flat());
    gaps.push(cos(left, right));
  }
  // Depth score: how far similarity climbs on each side of the gap before falling again.
  const depth = gaps.map((s, i) => {
    let l = s, r = s;
    for (let j = i - 1; j >= 0 && gaps[j] >= l; j--) l = gaps[j];
    for (let j = i + 1; j < gaps.length && gaps[j] >= r; j++) r = gaps[j];
    return (l - s) + (r - s);
  });
  const mean = depth.reduce((a, b) => a + b, 0) / depth.length;
  const sd = Math.sqrt(depth.reduce((a, d) => a + (d - mean) ** 2, 0) / depth.length);
  const cut = Math.max(0.05, mean - sd / 2);   // Hearst's "liberal" cutoff, with a small floor
  return depth.map((d, i) => (d > cut ? i + 1 : -1)).filter(i => i > 0);
}

function keywords(segTurns, allSegs, n = 5) {
  const tf = new Map(), surf = new Map();
  for (const t of segTurns) for (const { w, surface } of tokens(t.text)) {
    tf.set(w, (tf.get(w) || 0) + 1);
    const s = surf.get(w) || new Map(); s.set(surface, (s.get(surface) || 0) + 1); surf.set(w, s);
  }
  const df = w => allSegs.filter(seg => seg.some(t => tokens(t.text).some(x => x.w === w))).length;
  const scored = [...tf].map(([w, c]) => [w, c * Math.log(1 + allSegs.length / df(w)) * (c > 1 ? 1 : 0.5)]);
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, n).map(([w]) => [...surf.get(w)].sort((a, b) => b[1] - a[1])[0][0]);
}

function drivers(segTurns) {
  const by = new Map();
  for (const t of segTurns) by.set(t.speaker, (by.get(t.speaker) || 0) + tokens(t.text).length);
  const total = [...by.values()].reduce((a, b) => a + b, 0) || 1;
  const sorted = [...by].sort((a, b) => b[1] - a[1]);
  const top = sorted.filter(([, c]) => c / total >= 0.25).slice(0, 3).map(([id]) => id);
  return top.length ? top : sorted.slice(0, 1).map(([id]) => id);
}

// Strongest question or claim: deep questions and reasoned claims, nudged toward the topic words.
function keyQuote(segTurns, kw) {
  const kws = new Set(kw.map(stem));
  let best = null, bs = 0;
  for (const t of segTurns) splitSentences(t.text).forEach((s, i, sens) => {
    const q = isQuestion(s.text);
    let v = q ? (classifyQuestion(s.text).deep ? 3 : 0.5) : 0;
    const tags = reasoningTags(s.text, q);
    v += tags.length + (tags.includes('counter') || tags.includes('evidence') ? 1 : 0);
    v += 0.5 * tokens(s.text).filter(x => kws.has(x.w)).length;
    if (v > bs) { bs = v; best = { turnId: t.id, quote: quoteSpan(t.text, i, sens) }; }
  });
  return best;
}

export function segmentTopics(session) {
  const turns = (session.turns || []).filter(t => t.text && t.text.trim());
  if (!turns.length) return [];
  const dur = session.durationSec || turns[turns.length - 1].end;
  const bs = blockSeconds(dur);
  const blocks = [];
  for (const t of turns) {
    const b = Math.floor(t.start / bs);
    const last = blocks[blocks.length - 1];
    if (last && last.b === b) last.turns.push(t); else blocks.push({ b, turns: [t] });
  }
  const cuts = boundaries(blocks.map(b => b.turns));
  const segs = [];
  let from = 0;
  for (const c of [...cuts, blocks.length]) { segs.push(blocks.slice(from, c).flatMap(b => b.turns)); from = c; }
  return segs.map((seg, i) => {
    const kw = keywords(seg, segs);
    return {
      id: `topic${i + 1}`,
      title: kw.slice(0, 3).map((w, j) => (j ? w : w[0].toUpperCase() + w.slice(1))).join(', ') || `Topic ${i + 1}`,
      keywords: kw,
      start: seg[0].start, end: seg[seg.length - 1].end,
      turnIds: seg.map(t => t.id),
      drivers: drivers(seg),
      keyQuote: keyQuote(seg, kw),
    };
  });
}
