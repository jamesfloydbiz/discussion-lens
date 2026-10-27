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
    if (n < kk) break; // small groups were folded away: more speakers won't help
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
