// Runs the upload path (voiced windows → WeSpeaker voiceprints → regroup → buildTurns) on real
// audio and scores it against reference labels ([{ s, e } in ms, spk }]).
//   bun tools/check-upload.js [--audio a.f32 --ref ref.json] [--no-whisper]
// Defaults to spike/mix.f32 + spike/mix_ref.json. Audio is raw 16 kHz mono float32.
// Whisper phrases take ~1 min; --no-whisper cuts phrases from the reference segments instead.
// Embedding mirrors js/speakers.worker.js, using node_modules instead of the CDN.
import { existsSync, readFileSync } from 'fs';
import { AutoModel, AutoFeatureExtractor, pipeline } from '@huggingface/transformers';
import { SR, WIN } from '../js/audio.js';
import { planWindows, blockCuts, chunksToPhrases, assembleCapture, ASR_MODEL } from '../js/upload.js';
import { OnlineClusterer, normalize } from '../js/clustering.js';
import { buildTurns, speakerRuns } from '../js/turns.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const root = new URL('../spike/', import.meta.url).pathname;
const audioPath = arg('--audio', root + 'mix.f32'), refPath = arg('--ref', root + 'mix_ref.json');
for (const p of [audioPath, refPath]) if (!existsSync(p)) { console.log('Missing ' + p + '. Nothing to check.'); process.exit(1); }
const audio = new Float32Array(readFileSync(audioPath).buffer.slice(0));
const durationSec = audio.length / SR;
const ref = JSON.parse(readFileSync(refPath, 'utf8'))
  .map(r => ({ start: r.s / 1000, end: Math.min(r.e / 1000, durationSec), spk: String(r.spk) }))
  .filter(r => r.end > r.start);
const names = [...new Set(ref.map(r => r.spk))];
console.log(`${audioPath.split('/').pop()}: ${durationSec.toFixed(0)} s, ${ref.length} reference segments, voices: ${names.join(', ')}`);

// ---- embed (same as the worker) ----
const MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
const model = await AutoModel.from_pretrained(MODEL, { dtype: 'fp32' });
const fe = await AutoFeatureExtractor.from_pretrained(MODEL);
const times = planWindows(audio);
console.log(`voiced windows: ${times.length} of ${Math.floor((durationSec - WIN) / 0.75) + 1}`);
let t0 = performance.now();
const vectors = [];
for (const t of times) {
  const s = Math.round(t * SR);
  const out = await model(await fe(audio.subarray(s, s + Math.round(WIN * SR))));
  vectors.push(normalize(out.last_hidden_state.data));
}
console.log(`embedded in ${((performance.now() - t0) / 1000).toFixed(1)} s (${((performance.now() - t0) / times.length).toFixed(0)} ms/window, bun CPU)`);

// ---- scoring ----
// Confusion (seconds) between labelled spans and reference speakers, then the best one-to-one mapping.
function confusion(spans) {
  const m = new Map();
  for (const sp of spans) for (const r of ref) {
    const o = Math.min(sp.end, r.end) - Math.max(sp.start, r.start);
    if (o <= 0) continue;
    if (!m.has(sp.speaker)) m.set(sp.speaker, {});
    m.get(sp.speaker)[r.spk] = (m.get(sp.speaker)[r.spk] || 0) + o;
  }
  return m;
}
function bestMapping(m) {
  const labels = [...m.keys()];
  let best = 0;
  const go = (i, used, acc) => {
    if (i === labels.length) { best = Math.max(best, acc); return; }
    go(i + 1, used, acc);   // label maps to nobody (all its time counts as wrong)
    for (const n of names) if (!used.has(n)) { used.add(n); go(i + 1, used, acc + (m.get(labels[i])[n] || 0)); used.delete(n); }
  };
  go(0, new Set(), 0);
  return best;
}
// Denominator = labelled time that overlaps reference speech (gaps in the reference aren't scored).
function score(spans) {
  const m = confusion(spans);
  let total = 0; m.forEach(row => Object.values(row).forEach(x => total += x));
  return { pct: (100 * bestMapping(m) / total).toFixed(1) + '%', groups: new Set(spans.map(s => s.speaker)).size };
}
const windowsOf = labels => times.map((t, i) => ({ t, dur: WIN, speaker: labels[i] }));

// ---- phrases ----
let phrases;
if (process.argv.includes('--no-whisper')) {
  phrases = ref.map(r => ({ start: r.start, end: r.end, text: Array.from({ length: Math.round((r.end - r.start) * 2.5) }, () => 'w').join(' ') }));
  console.log('phrases: cut from the reference segments');
} else {
  t0 = performance.now();
  const asr = await pipeline('automatic-speech-recognition', ASR_MODEL, { dtype: 'q8' });
  const cuts = blockCuts(audio);
  phrases = [];
  for (let b = 0; b + 1 < cuts.length; b++) {
    const out = await asr(audio.slice(Math.round(cuts[b] * SR), Math.round(cuts[b + 1] * SR)), { chunk_length_s: 30, return_timestamps: true });
    phrases.push(...chunksToPhrases(out.chunks, cuts[b], cuts[b + 1]));
  }
  console.log(`phrases: ${phrases.length} from Whisper (${ASR_MODEL}, ${((performance.now() - t0) / 1000).toFixed(0)} s, ${cuts.length - 1} blocks)`);
}

// ---- results ----
const live = new OnlineClusterer(), liveLabels = vectors.map(v => live.add(v));
console.log('\nspeech time labelled correctly (best one-to-one mapping of groups to reference voices):');
const ls = score(speakerRuns(windowsOf(liveLabels)));
console.log(`  live OnlineClusterer        ${ls.pct.padStart(6)}  (${ls.groups} groups)`);
const refTurns = ref.filter((r, i) => i === 0 || r.spk !== ref[i - 1].spk).length;
for (const k of [0, names.length]) {
  const cap = assembleCapture({ phrases, times, vectors, expectedSpeakers: k, durationSec });
  const w = score(speakerRuns(cap.windows));
  const turns = buildTurns(cap.phrases, cap.windows);
  const tt = score(turns);
  const what = k ? `count given (k=${k})` : 'count unknown';
  console.log(`  regroup, ${what.padEnd(18)} ${w.pct.padStart(6)}  (${w.groups} speakers) · turns: ${tt.pct} of turn time, ${turns.length} turns vs ${refTurns} reference turns`);
}
