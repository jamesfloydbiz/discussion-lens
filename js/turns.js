// Phrases (ASR text with times) + labelled voiceprint windows → speaker turns.

export const SPLIT_MIN_SEC = 1.2;   // a run of another speaker this long inside a phrase splits it
export const MERGE_GAP_SEC = 1.5;   // same-speaker phrases closer than this join one turn

// Labelled windows → non-overlapping runs [{ speaker, start, end }].
// Each window owns the span around its centre up to halfway to its neighbours (its full span if alone).
export function speakerRuns(windows) {
  const ws = windows.filter(w => w.speaker !== null && w.speaker !== undefined)
    .map(w => ({ c: w.t + (w.dur ?? 1.5) / 2, half: (w.dur ?? 1.5) / 2, speaker: w.speaker }))
    .sort((a, b) => a.c - b.c);
  const runs = [];
  ws.forEach((w, i) => {
    const prev = ws[i - 1], next = ws[i + 1];
    const start = prev ? Math.max(w.c - w.half, (prev.c + w.c) / 2) : w.c - w.half;
    const end = next ? Math.min(w.c + w.half, (w.c + next.c) / 2) : w.c + w.half;
    const last = runs[runs.length - 1];
    if (last && last.speaker === w.speaker && start - last.end < 1e-6) last.end = end;
    else runs.push({ speaker: w.speaker, start, end });
  });
  return runs;
}

function nearestSpeaker(runs, t) {
  let best = null, bd = Infinity;
  for (const r of runs) {
    const d = t < r.start ? r.start - t : t > r.end ? t - r.end : 0;
    if (d < bd) { bd = d; best = r.speaker; }
  }
  return best ?? 0;
}

// One phrase → one or more { speaker, start, end, text } pieces.
function splitPhrase(p, runs) {
  const inside = runs.filter(r => r.end > p.start && r.start < p.end)
    .map(r => ({ speaker: r.speaker, start: Math.max(r.start, p.start), end: Math.min(r.end, p.end) }));
  if (!inside.length) return [{ speaker: nearestSpeaker(runs, (p.start + p.end) / 2), start: p.start, end: p.end, text: p.text }];

  // Merge same-speaker neighbours (across gaps), then fold short runs into a neighbour.
  let segs = [];
  for (const r of inside) {
    const last = segs[segs.length - 1];
    if (last && last.speaker === r.speaker) { last.end = r.end; last.dur += r.end - r.start; }
    else segs.push({ ...r, dur: r.end - r.start });
  }
  const long = segs.filter(s => s.dur >= SPLIT_MIN_SEC);
  if (long.length < 2) {
    const tot = {};
    for (const s of segs) tot[s.speaker] = (tot[s.speaker] || 0) + s.dur;
    const speaker = +Object.entries(tot).sort((a, b) => b[1] - a[1])[0][0];
    return [{ speaker, start: p.start, end: p.end, text: p.text }];
  }
  // Short runs join the previous long run (or the first long run, at the start).
  const pieces = [];
  let lead = 0;
  for (const s of segs) {
    const last = pieces[pieces.length - 1];
    if (s.dur >= SPLIT_MIN_SEC && !(last && last.speaker === s.speaker)) pieces.push({ ...s, dur: s.dur + lead });
    else if (last) { last.end = s.end; last.dur += s.dur; }
    else lead += s.dur;
    if (pieces.length) lead = 0;
  }
  if (pieces.length < 2) return [{ speaker: pieces[0].speaker, start: p.start, end: p.end, text: p.text }];
  pieces[0].start = p.start; pieces[pieces.length - 1].end = p.end;
  for (let i = 1; i < pieces.length; i++) pieces[i].start = pieces[i - 1].end;

  // Words in proportion to each piece's speech time.
  const words = p.text.split(/\s+/).filter(Boolean);
  const total = pieces.reduce((n, s) => n + s.dur, 0);
  const out = [];
  let acc = 0, from = 0;
  pieces.forEach((s, i) => {
    acc += s.dur;
    const to = i === pieces.length - 1 ? words.length : Math.round(words.length * acc / total);
    if (to > from) out.push({ speaker: s.speaker, start: s.start, end: s.end, text: words.slice(from, to).join(' ') });
    else if (out.length) out[out.length - 1].end = s.end;   // too short to get a word
    from = Math.max(from, to);
  });
  if (out.length) { out[0].start = p.start; out[out.length - 1].end = p.end; }
  return out;
}

// Phrases cut wherever the windows show another speaker for ≥ SPLIT_MIN_SEC → [{ speaker, start, end, text }].
export function splitPhrases(phrases, windows) {
  const runs = speakerRuns(windows);
  return phrases.filter(p => p.text && p.text.trim()).slice().sort((a, b) => a.start - b.start)
    .flatMap(p => splitPhrase({ ...p, text: p.text.trim() }, runs));
}

// buildTurns(phrases, windows) → [{ id: 't1', speaker, start, end, text, signals: {} }]
export function buildTurns(phrases, windows) {
  const pieces = splitPhrases(phrases, windows);
  const turns = [];
  for (const s of pieces) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < MERGE_GAP_SEC) {
      last.end = Math.max(last.end, s.end); last.text += ' ' + s.text;
    } else turns.push({ speaker: s.speaker, start: s.start, end: s.end, text: s.text });
  }
  return turns.map((t, i) => ({ id: 't' + (i + 1), ...t, signals: {} }));
}
