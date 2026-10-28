import { test, expect } from 'bun:test';
import { buildTurns, speakerRuns } from '../js/turns.js';
import { regroup, labelPhrases, meanInside } from '../js/clustering.js';

// Windows every 0.75 s from `from` to `to`, all one speaker.
const span = (from, to, speaker) => {
  const ws = [];
  for (let t = from; t + 1.5 <= to + 1e-9; t += 0.75) ws.push({ t, dur: 1.5, speaker });
  return ws;
};

test('speakerRuns: contiguous windows make one run per speaker change', () => {
  const runs = speakerRuns([...span(0, 6, 0), ...span(6, 12, 1)]);
  expect(runs.map(r => r.speaker)).toEqual([0, 1]);
  expect(runs[0].start).toBe(0);
  expect(runs[1].end).toBe(12);
  expect(runs[0].end).toBeCloseTo(runs[1].start);
});

test('same-speaker phrases with a short gap merge; a long gap or a new speaker starts a turn', () => {
  const windows = [...span(0, 12, 0), ...span(12, 20, 1)];
  const phrases = [
    { start: 0, end: 3, text: 'first part' },
    { start: 4, end: 6, text: 'second part' },      // gap 1.0 → merge
    { start: 8, end: 10, text: 'after a pause' },   // gap 2.0 → new turn
    { start: 13, end: 16, text: 'other voice' },    // speaker 1
  ];
  const turns = buildTurns(phrases, windows);
  expect(turns.map(t => [t.id, t.speaker, t.text])).toEqual([
    ['t1', 0, 'first part second part'],
    ['t2', 0, 'after a pause'],
    ['t3', 1, 'other voice'],
  ]);
  expect(turns[0].start).toBe(0);
  expect(turns[0].end).toBe(6);
  expect(turns.every(t => typeof t.signals === 'object' && !Object.keys(t.signals).length)).toBe(true);
});

test('a phrase spanning a speaker change is split, words in proportion to run length', () => {
  const windows = [...span(0, 6, 0), ...span(6, 12, 1)];
  const text = 'one two three four five six seven eight nine ten eleven twelve';
  const turns = buildTurns([{ start: 2, end: 10, text }], windows);
  expect(turns.length).toBe(2);
  expect(turns[0]).toMatchObject({ id: 't1', speaker: 0, start: 2, text: 'one two three four five six' });
  expect(turns[1]).toMatchObject({ id: 't2', speaker: 1, end: 10, text: 'seven eight nine ten eleven twelve' });
  expect(turns[0].end).toBeCloseTo(6);
});

test('a short run of another speaker (< 1.2 s) does not split a phrase', () => {
  // speaker 1 for one window (owns ~0.75 s) inside speaker 0
  const windows = [...span(0, 6, 0), { t: 5.25, dur: 1.5, speaker: 1 }, ...span(6, 12, 0)]
    .sort((a, b) => a.t - b.t);
  const turns = buildTurns([{ start: 1, end: 11, text: 'a b c d e f g h' }], windows);
  expect(turns.length).toBe(1);
  expect(turns[0]).toMatchObject({ speaker: 0, text: 'a b c d e f g h', start: 1, end: 11 });
});

test('a split piece too short for a word folds into its neighbour', () => {
  const windows = [...span(0, 6, 0), ...span(6, 12, 1)];
  // 6 s of speaker 0 vs 1.5 s of speaker 1: speaker 0 gets round(2 * 6/7.5) = 2 words, speaker 1 none
  const turns = buildTurns([{ start: 0, end: 7.5, text: 'two words' }], windows);
  expect(turns).toEqual([{ id: 't1', speaker: 0, start: 0, end: 7.5, text: 'two words', signals: {} }]);
});

test('phrases outside any window take the nearest speaker; empty phrases are dropped', () => {
  const windows = [...span(10, 14, 1)];
  const turns = buildTurns([{ start: 0, end: 2, text: 'early words' }, { start: 3, end: 4, text: '  ' }], windows);
  expect(turns).toEqual([{ id: 't1', speaker: 1, start: 0, end: 2, text: 'early words', signals: {} }]);
});

test('no windows at all: everything is speaker 0', () => {
  const turns = buildTurns([{ start: 0, end: 1, text: 'hi' }, { start: 1.5, end: 2, text: 'there' }], []);
  expect(turns).toEqual([{ id: 't1', speaker: 0, start: 0, end: 2, text: 'hi there', signals: {} }]);
});

// Deterministic Gaussian noise.
function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647; const u = seed / 2147483647;
    seed = (seed * 16807) % 2147483647; const v = seed / 2147483647;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}
const unit = v => { const n = Math.hypot(...v); return Float32Array.from(v, x => x / n); };

test('regroup recovers 3 synthetic speakers from noisy vectors (count unknown and given)', () => {
  const g = rng(42), dim = 64;
  const centres = [0, 1, 2].map(() => unit(Array.from({ length: dim }, g)));
  const truth = [], vectors = [];
  // talk in turns of 4–12 windows, uneven shares
  for (let turn = 0; turn < 60; turn++) {
    const s = [0, 1, 2, 0, 1, 0][turn % 6], len = 4 + (turn * 7) % 9;
    for (let i = 0; i < len; i++) {
      truth.push(s);
      vectors.push(unit(Array.from(centres[s], x => x + 0.12 * g())));   // noise norm ≈ signal: cos to centre ≈ 0.7, same-speaker pairs ≈ 0.5
    }
  }
  for (const k of [0, 3]) {
    const labels = regroup(vectors, { k });
    expect(new Set(labels).size).toBe(3);
    // best mapping = majority truth per label (labels are distinct speakers)
    const m = {};
    labels.forEach((l, i) => { m[l] ??= [0, 0, 0]; m[l][truth[i]]++; });
    const correct = Object.values(m).reduce((n, c) => n + Math.max(...c), 0);
    expect(correct / labels.length).toBeGreaterThan(0.95);
  }
});

test('labelPhrases: quiet speaker kept, muddled pieces broken up when the count is given, nulls stay null', () => {
  const g = rng(7), dim = 64;
  const centres = [0, 1, 2].map(() => unit(Array.from({ length: dim }, g)));
  const truth = [], vectors = [];
  const say = s => { truth.push(s); vectors.push(unit(Array.from(centres[s], x => x + 0.1 * g()))); };
  for (let i = 0; i < 40; i++) say(i % 2);              // two talkative speakers
  for (let i = 0; i < 5; i++) say(2);                   // a quiet one
  for (let i = 0; i < 6; i++) {                         // muddled pieces: half one voice, half another
    truth.push(null); vectors.push(unit(Array.from(centres[0], (x, d) => x + centres[1][d] + 0.3 * g())));
  }
  truth.push(null); vectors.push(null);
  for (const k of [0, 3]) {
    const labels = labelPhrases(vectors, { k });
    expect(labels.at(-1)).toBeNull();
    const m = {};
    truth.forEach((t, i) => { if (t === null) return; m[labels[i]] ??= [0, 0, 0]; m[labels[i]][t]++; });
    expect(Object.keys(m).length).toBe(3);   // the quiet speaker is its own group
    for (const c of Object.values(m)) expect(Math.max(...c)).toBe(c.reduce((a, b) => a + b, 0));
    if (k) expect(new Set(labels.filter(l => l !== null)).size).toBe(3);
  }
});

test('meanInside averages only the windows inside a span', () => {
  const v = [Float32Array.of(1, 0), Float32Array.of(0, 1), Float32Array.of(1, 0)];
  expect([...meanInside([0, 2, 4], v, 0, 1.5, 1.5)]).toEqual([1, 0]);
  expect(meanInside([0, 2, 4], v, 10, 12, 1.5)).toBeNull();
  const m = meanInside([0, 2, 4], v, 0, 3.5, 1.5);
  expect(m[0]).toBeCloseTo(Math.SQRT1_2); expect(m[1]).toBeCloseTo(Math.SQRT1_2);
});
