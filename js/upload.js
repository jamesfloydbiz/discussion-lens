// Uploaded recording → Capture: decode, resample to 16 kHz mono, Whisper transcript (worker),
// voiceprints for every voiced window (speaker worker), final regroup.
import { NoiseGate, rms, SR, WIN, HOP } from './audio.js';
import { openSpeakerModel, packEmbeddings, workerRpc } from './live.js';
import { regroup } from './clustering.js';

export const ASR_MODEL = 'onnx-community/whisper-base.en';
const BLOCK_SEC = 300;     // Whisper runs in ~5 min blocks so we can report progress
const IN_FLIGHT = 4;       // embed jobs posted to the speaker worker at once

// ---- pure helpers (also used by tools/check-upload.js) ----

// Start times of voiced windows on the hop grid.
export function planWindows(audio) {
  const gate = new NoiseGate(), ts = [];
  for (let k = 0; k * HOP + WIN <= audio.length / SR + 1e-9; k++) {
    const t = k * HOP, i = Math.round(t * SR);
    if (gate.voiced(rms(audio.subarray(i, i + Math.round(WIN * SR))))) ts.push(t);
  }
  return ts;
}

// Cut points (seconds) every ~blockSec, moved to the quietest 100 ms in the 5 s before each cut.
export function blockCuts(audio, blockSec = BLOCK_SEC) {
  const dur = audio.length / SR, cuts = [0];
  for (let c = blockSec; c < dur - 10; c += blockSec) {
    let best = c, br = Infinity;
    for (let t = c - 5; t <= c; t += 0.05) {
      const i = Math.round(t * SR), r = rms(audio.subarray(i, i + SR / 10));
      if (r < br) { br = r; best = t + 0.05; }
    }
    cuts.push(best);
  }
  cuts.push(dur);
  return cuts;
}

// Whisper chunks of one block → phrases (times offset to the recording).
const NOISE = /^[\s([{♪*-]*(blank_audio|music|silence|applause|laughter|inaudible|no speech)?[\s)\]}♪*.-]*$/i;
export function chunksToPhrases(chunks, offset, blockEnd) {
  const out = [];
  for (const c of chunks || []) {
    const text = (c.text || '').trim();
    if (!text || NOISE.test(text)) continue;
    const [s, e] = c.timestamp || [];
    const start = offset + (s ?? 0), end = Math.min(blockEnd, e == null ? blockEnd : offset + e);
    out.push({ start, end: Math.max(end, start + 0.2), text });
  }
  return out;
}

// Windows + vectors (time order) + phrases → Capture.
export function assembleCapture({ phrases, times, vectors, expectedSpeakers = 0, durationSec }) {
  const labels = regroup(vectors, { k: expectedSpeakers || 0 });
  return {
    phrases: phrases.map((p, i) => ({ id: 'p' + (i + 1), start: p.start, end: p.end, text: p.text, source: 'whisper' })),
    windows: times.map((t, i) => ({ t, dur: WIN, speaker: labels[i] })),
    embeddings: packEmbeddings(vectors),
    durationSec,
  };
}

// ---- browser ----

export async function decodeTo16k(file) {
  const buf = await file.arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
  const ctx = new OfflineAudioContext(1, Math.ceil(decoded.duration * SR), SR);   // 1 channel = mono downmix
  const src = ctx.createBufferSource(); src.buffer = decoded; src.connect(ctx.destination); src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

// Whisper worker, inline so it ships with this module.
const ASR_WORKER = `
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
env.allowLocalModels = false;
let asr = null;
async function load(model) {
  const progress_callback = p => { if (p.status === 'progress' || p.status === 'done') self.postMessage({ type: 'progress', ...p }); };
  const hasGpu = !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
  const tries = hasGpu ? [['webgpu', { encoder_model: 'fp32', decoder_model_merged: 'q4' }], ['wasm', 'q8']] : [['wasm', 'q8']];
  for (const [device, dtype] of tries) {
    try {
      asr = await pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback });
      await asr(new Float32Array(16000), { return_timestamps: true });   // warm-up, catches unsupported ops
      return device;
    } catch (e) { asr = null; if (device === 'wasm') throw e; }
  }
}
self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') self.postMessage({ type: 'ready', device: await load(m.model) });
    if (m.type === 'transcribe') {
      const out = await asr(m.audio, { chunk_length_s: 30, return_timestamps: true });
      self.postMessage({ type: 'result', id: m.id, chunks: out.chunks || [{ text: out.text, timestamp: [0, null] }] });
    }
  } catch (e) { self.postMessage({ type: 'error', id: m.id, message: e.message }); }
};`;

// Whisper worker client. `ready` and every pending transcribe reject if the worker fails at any point.
export function openAsr(onProgress = () => {}, makeWorker = () => {
  const url = URL.createObjectURL(new Blob([ASR_WORKER], { type: 'text/javascript' }));
  const w = new Worker(url, { type: 'module' });
  URL.revokeObjectURL(url);
  return w;
}) {
  const files = {};
  let readyRes, readyRej;
  const ready = new Promise((res, rej) => { readyRes = res; readyRej = rej; });
  ready.catch(() => {});
  const rpc = workerRpc(makeWorker(), {
    name: 'Transcription worker',
    onOther(m) {
      if (m.type === 'progress') {
        if (m.file) files[m.file] = { loaded: m.loaded ?? files[m.file]?.total ?? 0, total: m.total ?? files[m.file]?.total ?? 0 };
        const fs = Object.values(files), total = fs.reduce((n, f) => n + (f.total || 0), 0);
        const loaded = fs.reduce((n, f) => n + (f.loaded || 0), 0);
        onProgress({ stage: 'asr-model', loaded, total, progress: total ? loaded / total : 0 });
      } else if (m.type === 'ready') { onProgress({ stage: 'asr-model', progress: 1, device: m.device }); readyRes(m.device); }
      else if (m.type === 'error') rpc.fail(new Error('Transcription model failed to load: ' + m.message));
    },
  });
  rpc.onDead(readyRej);
  rpc.send({ type: 'init', model: ASR_MODEL });
  return {
    ready,
    transcribe: audio => rpc.call({ type: 'transcribe', audio }, [audio.buffer]).then(m => m.chunks),
    close: () => rpc.close(),
  };
}

// processUpload(file, { expectedSpeakers, onProgress }) → Promise<Capture>
// onProgress({ stage: 'decode'|'speaker-model'|'asr-model'|'speakers'|'transcribe'|'regroup'|'done', progress 0–1, … })
export async function processUpload(file, { expectedSpeakers = 0, onProgress = () => {} } = {}) {
  onProgress({ stage: 'decode', progress: 0 });
  let audio;
  try { audio = await decodeTo16k(file); }
  catch (e) { throw new Error('Could not read this file as audio (' + (e.message || e) + '). Try an MP3, M4A or WAV.'); }
  const durationSec = audio.length / SR;
  onProgress({ stage: 'decode', progress: 1, durationSec });

  const speakers = openSpeakerModel(onProgress);
  const asr = openAsr(onProgress);
  try {
    // Voiceprints: every voiced window, a few in flight at a time.
    const embedAll = async () => {
      await speakers.ready;
      const times = planWindows(audio), vectors = new Array(times.length);
      let next = 0, done = 0;
      const lane = async () => {
        while (next < times.length) {
          const i = next++, s = Math.round(times[i] * SR);
          vectors[i] = await speakers.embed(times[i], audio.slice(s, s + Math.round(WIN * SR)));
          if (++done % 20 === 0 || done === times.length) onProgress({ stage: 'speakers', progress: done / times.length });
        }
      };
      await Promise.all(Array.from({ length: IN_FLIGHT }, lane));
      return { times, vectors };
    };
    // Transcript: Whisper block by block.
    const transcribeAll = async () => {
      await asr.ready;
      const cuts = blockCuts(audio), phrases = [];
      for (let b = 0; b + 1 < cuts.length; b++) {
        onProgress({ stage: 'transcribe', progress: cuts[b] / durationSec });
        const block = audio.slice(Math.round(cuts[b] * SR), Math.round(cuts[b + 1] * SR));
        phrases.push(...chunksToPhrases(await asr.transcribe(block), cuts[b], cuts[b + 1]));
      }
      onProgress({ stage: 'transcribe', progress: 1 });
      return phrases;
    };
    const [{ times, vectors }, phrases] = await Promise.all([embedAll(), transcribeAll()]);
    onProgress({ stage: 'regroup' });
    const capture = assembleCapture({ phrases, times, vectors, expectedSpeakers, durationSec });
    onProgress({ stage: 'done', progress: 1 });
    return capture;
  } finally {
    speakers.close(); asr.close();
  }
}
