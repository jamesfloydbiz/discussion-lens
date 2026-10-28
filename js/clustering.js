// Speaker grouping from voiceprints (L2-normalised embeddings of ~1.5 s windows).
// Thresholds come from spike/spike.js on real recordings (see README "Speaker accuracy").

export const LIVE_THRESHOLD = 0.15;   // new speaker if no centroid is this similar
export const MERGE_THRESHOLD = 0.2;   // optional fixed cutoff for regroup({threshold})
const MICRO_THRESHOLD = 0.35;         // first pass of the final regroup (many small groups)

export function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return s / (Math.sqrt(na * nb) || 1);
}

export function normalize(v) {
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return Float32Array.from(v, x => x / n);
}

// Live: assign each window to the nearest running centroid, or start a new speaker.
export class OnlineClusterer {
  constructor(threshold = LIVE_THRESHOLD) { this.threshold = threshold; this.centroids = []; }
  add(v) {
    let best = -1, bestSim = -2;
    this.centroids.forEach((c, i) => { const s = cosine(c.sum, v); if (s > bestSim) { bestSim = s; best = i; } });
    if (best < 0 || bestSim < this.threshold) {
      this.centroids.push({ sum: Float32Array.from(v), n: 1 });
      return this.centroids.length - 1;
    }
    const c = this.centroids[best]; c.n++;
    for (let d = 0; d < v.length; d++) c.sum[d] += v[d];
    return best;
  }
}

// Agglomerative merge of weighted groups until `k` remain, or until nothing is more similar than `threshold`.
function mergeGroups(groups, { k, threshold }) {
  groups = groups.map(g => ({ ...g, sum: Float32Array.from(g.sum) }));
  while (groups.length > 1 && (!k || groups.length > k)) {
    let bi = -1, bj = -1, bs = -2;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const s = cosine(groups[i].sum, groups[j].sum);
      if (s > bs) { bs = s; bi = i; bj = j; }
    }
    if (!k && bs < threshold) break;
    const a = groups[bi], b = groups[bj];
    for (let d = 0; d < a.sum.length; d++) a.sum[d] += b.sum[d];
    a.members = a.members.concat(b.members); a.n += b.n;
    groups.splice(bj, 1);
  }
  return groups;
}

// Final regroup of every window: micro-groups first (keeps it fast for an hour of audio),
// then merge them to `k` speakers if known, else by threshold. Tiny leftover groups
// (under minShare of speech) are folded into their nearest real speaker.
// Count unknown: try 2..MAX_SPEAKERS and keep the best-separated grouping (silhouette).
// A fixed merge threshold collapsed 5 distinct voices into 1 in testing.
const MAX_SPEAKERS = 8, MIN_SILHOUETTE = 0.08, SAMPLE = 500;

export function regroup(vectors, { k = 0, threshold = 0, minShare = 0.03 } = {}) {
  if (!vectors.length) return [];
  if (k || threshold) return groupInto(vectors, { k, threshold, minShare });
  let best = null;
  for (let kk = 2; kk <= Math.min(MAX_SPEAKERS, vectors.length - 1); kk++) {
    const labels = groupInto(vectors, { k: kk, minShare });
    const n = new Set(labels).size;
    // Small groups can be folded away (k=2 became 1 on a 6-voice seminar), so keep trying larger k.
    if (n < 2) continue;
    const s = silhouette(vectors, labels);
    if (!best || s > best.s) best = { s, labels };
  }
  if (!best || best.s < MIN_SILHOUETTE) return vectors.map(() => 0);
  return best.labels;
}

// Mean silhouette on an even sample of windows (cosine distance).
export function silhouette(vectors, labels) {
  const step = Math.max(1, Math.floor(vectors.length / SAMPLE)), idx = [];
  for (let i = 0; i < vectors.length; i += step) idx.push(i);
  let total = 0;
  for (const i of idx) {
    const sum = {}, cnt = {};
    for (const j of idx) {
      if (i === j) continue;
      const d = 1 - cosine(vectors[i], vectors[j]);
      sum[labels[j]] = (sum[labels[j]] || 0) + d; cnt[labels[j]] = (cnt[labels[j]] || 0) + 1;
    }
    const a = cnt[labels[i]] ? sum[labels[i]] / cnt[labels[i]] : 0;
    let b = Infinity;
    for (const l in sum) if (+l !== labels[i]) b = Math.min(b, sum[l] / cnt[l]);
    if (b === Infinity || !cnt[labels[i]]) continue;
    total += (b - a) / Math.max(a, b);
  }
  return total / idx.length;
}

function groupInto(vectors, { k, threshold, minShare }) {
  const micro = new OnlineClusterer(MICRO_THRESHOLD);
  const microOf = vectors.map(v => micro.add(v));
  let groups = micro.centroids.map((c, i) => ({ sum: c.sum, n: c.n, members: [i] }));
  groups = mergeGroups(groups, { k, threshold });
  const big = groups.filter(g => g.n >= minShare * vectors.length);
  const keep = big.length ? big : groups;
  for (const g of groups) {
    if (keep.includes(g)) continue;
    let best = keep[0], bs = -2;
    for (const h of keep) { const s = cosine(h.sum, g.sum); if (s > bs) { bs = s; best = h; } }
    best.members = best.members.concat(g.members); best.n += g.n;
  }
  // Number speakers by first appearance so labels read naturally.
  const groupOfMicro = new Map();
  keep.forEach((g, gi) => g.members.forEach(m => groupOfMicro.set(m, gi)));
  const raw = microOf.map(m => groupOfMicro.get(m));
  const order = new Map();
  return raw.map(g => { if (!order.has(g)) order.set(g, order.size); return order.get(g); });
}

// Speakers per transcript phrase piece, from one voiceprint per piece (null = none; that piece gets null).
// A whole phrase carries far more of a voice than a 1.5 s window (spike/sem/eval.js on a 6-min, ~7-voice
// classroom seminar: 67% of speech time right with windows, ~90% by phrase piece). Pieces are few and clean,
// so plain average-linkage clustering is used; on the seminar it held ~90% for any k from 7 to 9, where
// regroup() swung from 66% to 86%. The count is chosen by silhouette among 2..MAX_SPEAKERS+2, or among
// k..k+2 when the user gives k: forcing exactly k made muddled pieces (two voices) push real voices
// together (synthetic 5 voices: 82% forced, 96% with the spare groups, which hold a few seconds each).
export function labelPhrases(vectors, { k = 0 } = {}) {
  const idx = [];
  vectors.forEach((v, i) => { if (v) idx.push(i); });
  const labels = vectors.map(() => null);
  const vs = idx.map(i => vectors[i]), n = vs.length;
  if (n < 3) { idx.forEach(i => { labels[i] = 0; }); return labels; }
  const lo = k ? Math.min(k, n - 1) : 2, hi = Math.min(n - 1, (k || MAX_SPEAKERS) + 2);
  const snaps = averageLinkage(vs, hi);
  let pick, best = -Infinity;
  for (let kk = lo; kk <= hi; kk++) { const s = silhouette(vs, snaps.get(kk)); if (s > best) { best = s; pick = snaps.get(kk); } }
  if (!k && best < MIN_SILHOUETTE) pick = vs.map(() => 0);
  const order = new Map();
  pick.forEach((g, j) => { if (!order.has(g)) order.set(g, order.size); labels[idx[j]] = order.get(g); });
  return labels;
}

// Average-linkage agglomerative clustering on cosine similarity. Returns Map(clusterCount → labels)
// for every count from maxK down to 1. O(n²) memory, O(n³) time worst case: fine for a few thousand pieces.
function averageLinkage(vs, maxK) {
  const n = vs.length, sim = new Float64Array(n * n), size = new Array(n).fill(1), alive = new Array(n).fill(true);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) sim[i * n + j] = sim[j * n + i] = cosine(vs[i], vs[j]);
  const owner = vs.map((_, i) => i), snaps = new Map();
  for (let count = n; count >= 1; count--) {
    if (count <= maxK) snaps.set(count, owner.map(o => o));
    if (count === 1) break;
    let a = -1, b = -1, bs = -Infinity;
    for (let i = 0; i < n; i++) if (alive[i]) for (let j = i + 1; j < n; j++) if (alive[j] && sim[i * n + j] > bs) { bs = sim[i * n + j]; a = i; b = j; }
    for (let j = 0; j < n; j++) if (alive[j] && j !== a && j !== b) {   // Lance–Williams update for average linkage
      const v = (size[a] * sim[a * n + j] + size[b] * sim[b * n + j]) / (size[a] + size[b]);
      sim[a * n + j] = sim[j * n + a] = v;
    }
    size[a] += size[b]; alive[b] = false;
    for (let i = 0; i < n; i++) if (owner[i] === b) owner[i] = a;
  }
  return snaps;
}

// Mean (re-normalised) of the window voiceprints that sit inside [start, end] (±0.3 s); null if none.
export function meanInside(times, vectors, start, end, dur) {
  let sum = null;
  times.forEach((t, i) => {
    if (t < start - 0.3 || t + dur > end + 0.3) return;
    sum ||= new Float32Array(vectors[i].length);
    for (let d = 0; d < sum.length; d++) sum[d] += vectors[i][d];
  });
  return sum && normalize(sum);
}
