// Uploaded recording → Capture: decode, resample to 16 kHz mono, Whisper transcript (worker),
// voiceprints (speaker worker): windows find speaker changes, then one per phrase piece, grouped into speakers.
import { NoiseGate, rms, SR, WIN, HOP } from './audio.js';
import { openSpeakerModel, packEmbeddings, workerRpc, LOW_MEMORY } from './live.js';
import { labelPhrases, regroup } from './clustering.js';
import { splitPhrases } from './turns.js';

export const ASR_MODEL = 'onnx-community/whisper-base.en';
// Whisper hears 30 s at a time. Its own chunking overlaps windows and repeated sentences where they were
// stitched, so we cut ≤30 s blocks at quiet moments instead (17–22 s, the last block up to 30 s).
const BLOCK_SEC = 22;
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
  for (let c = blockSec; c < dur - 3; c += blockSec) {
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

// Speakers are found in two passes. 1.5 s window voiceprints are too short to tell similar voices apart
// (67% on a classroom seminar) but do show where a phrase switches speaker, so phrases are cut there.
// Then each piece gets one voiceprint from its own audio and pieces are grouped.
// Speech time labelled correctly: seminar (~7 voices) 67% → 94.5%; synthetic 5 voices 88.6% → 96.0%.
export function segmentPhrases(phrases, times, vectors, k = 0) {
  const labels = regroup(vectors, { k });
  return splitPhrases(phrases, times.map((t, i) => ({ t, dur: WIN, speaker: labels[i] })))
    .map(p => ({ start: p.start, end: p.end }));
}

// The audio a piece's voiceprint is taken from. Whisper's phrase ends run 0.3–0.8 s late and pick up the
// next voice, so pieces over 2.5 s are trimmed (whole pieces: 82.5% on the synthetic test, trimmed 96.0%).
export function pieceAudio(audio, p) {
  const [a, b] = p.end - p.start > 2.5 ? [p.start + 0.2, p.end - 0.6] : [p.start, Math.max(p.end, p.start + WIN)];
  return audio.slice(Math.round(a * SR), Math.round(b * SR));
}

// Phrases + pieces with one voiceprint each (time order) → Capture. Each piece is one window.
export function assembleCapture({ phrases, pieces, vectors, expectedSpeakers = 0, durationSec }) {
  const labels = labelPhrases(vectors, { k: expectedSpeakers || 0 });
  const voiced = pieces.map((p, i) => i).filter(i => vectors[i]);
  return {
    phrases: phrases.map((p, i) => ({ id: 'p' + (i + 1), start: p.start, end: p.end, text: p.text, source: 'whisper' })),
    windows: voiced.map(i => ({ t: pieces[i].start, dur: pieces[i].end - pieces[i].start, speaker: labels[i] })),
    embeddings: packEmbeddings(voiced.map(i => vectors[i])),
    durationSec,
  };
}

// ---- browser ----

// Decoding a whole file holds it at full rate: an hour of 44.1 kHz stereo MP3 peaked at 2.95 GB in Chromium,
// enough for Safari to reload the tab. MP3 (independent frames) and WAV (raw samples) are decoded in pieces
// of PIECE_BYTES instead; other formats (e.g. .m4a) are decoded whole.
const PIECE_BYTES = 4 << 20;   // ~4 min of 128 kbps MP3

export async function decodeTo16k(file) {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const tag = String.fromCharCode(...head.subarray(0, 4)), wave = String.fromCharCode(...head.subarray(8, 12));
  const isMp3 = tag.startsWith('ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) || /\.mp3$/i.test(file.name || '');
  try {
    if (isMp3 && file.size > PIECE_BYTES) return concat(await mp3Pieces(file));
    if (tag === 'RIFF' && wave === 'WAVE' && file.size > PIECE_BYTES) return concat(await wavPieces(file));
  } catch (e) { /* a piece would not decode: fall back to the whole file */ }
  return mono(await decode16k(await file.arrayBuffer()));
}

// decodeAudioData resamples to its context's rate, so each piece arrives at 16 kHz.
async function decode16k(buf) {
  try { return await new OfflineAudioContext(1, 1, SR).decodeAudioData(buf); }
  catch (e) {   // a browser that won't decode at 16 kHz: decode at 44.1 kHz and resample by rendering
    const full = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
    const ctx = new OfflineAudioContext(1, Math.ceil(full.duration * SR), SR);   // 1 channel = mono downmix
    const src = ctx.createBufferSource(); src.buffer = full; src.connect(ctx.destination); src.start();
    return ctx.startRendering();
  }
}

function mono(buf) {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length), chans = buf.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / chans;
  }
  return out;
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// MP3 decoders resync at the next frame header, so byte slices decode on their own. ~25 ms is lost per cut
// (0.3 s over an hour vs ffmpeg); transcript and voiceprints share this audio, so they stay aligned.
async function mp3Pieces(file) {
  const parts = [];
  for (let o = 0; o < file.size; o += PIECE_BYTES) parts.push(mono(await decode16k(await file.slice(o, o + PIECE_BYTES).arrayBuffer())));
  return parts;
}

// WAV: copy the header with the data size patched, so each slice of samples is a small WAV of its own.
async function wavPieces(file) {
  const buf = new DataView(await file.slice(0, Math.min(file.size, 1 << 16)).arrayBuffer());
  let p = 12, align = 0, dataAt = -1, dataLen = 0;
  while (p + 8 <= buf.byteLength) {
    const id = String.fromCharCode(buf.getUint8(p), buf.getUint8(p + 1), buf.getUint8(p + 2), buf.getUint8(p + 3)), len = buf.getUint32(p + 4, true);
    if (id === 'fmt ') align = buf.getUint16(p + 20, true);
    if (id === 'data') { dataAt = p + 8; dataLen = Math.min(len, file.size - dataAt); break; }
    p += 8 + len + (len & 1);
  }
  if (dataAt < 0 || !align) throw new Error('WAV without fmt/data');
  const header = new Uint8Array(await file.slice(0, dataAt).arrayBuffer()), step = PIECE_BYTES - (PIECE_BYTES % align), parts = [];
  for (let o = 0; o < dataLen; o += step) {
    const body = new Uint8Array(await file.slice(dataAt + o, dataAt + Math.min(dataLen, o + step)).arrayBuffer());
    const piece = new Uint8Array(header.length + body.length);
    piece.set(header); piece.set(body, header.length);
    const v = new DataView(piece.buffer);
    v.setUint32(4, piece.length - 8, true); v.setUint32(dataAt - 4, body.length, true);
    parts.push(mono(await decode16k(piece.buffer)));
  }
  return parts;
}

// Whisper worker, inline so it ships with this module.
const ASR_WORKER = `
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
env.allowLocalModels = false;
let asr = null;
async function load(model, cpu) {
  const progress_callback = p => { if (p.status === 'progress' || p.status === 'done') self.postMessage({ type: 'progress', ...p }); };
  const hasGpu = !cpu && !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
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
    if (m.type === 'init') self.postMessage({ type: 'ready', device: await load(m.model, m.cpu) });
    if (m.type === 'transcribe') {
      const out = await asr(m.audio, { return_timestamps: true });
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
  rpc.send({ type: 'init', model: ASR_MODEL, cpu: LOW_MEMORY });
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

  // One model at a time: both loaded together took 2.4 GB on a 6-min file, enough for Safari to reload the tab.
  // Transcript first (Whisper block by block), then voiceprints.
  const phrases = [];
  const asr = openAsr(onProgress);
  try {
    await asr.ready;
    const cuts = blockCuts(audio);
    for (let b = 0; b + 1 < cuts.length; b++) {
      onProgress({ stage: 'transcribe', progress: cuts[b] / durationSec });
      const block = audio.slice(Math.round(cuts[b] * SR), Math.round(cuts[b + 1] * SR));
      phrases.push(...chunksToPhrases(await asr.transcribe(block), cuts[b], cuts[b + 1]));
    }
    onProgress({ stage: 'transcribe', progress: 1 });
  } finally { asr.close(); }

  // Voiceprints: every voiced window (to find speaker changes), then each phrase piece as a whole.
  let pieces, vectors;
  const speakers = openSpeakerModel(onProgress);
  try {
    await speakers.ready;
    const embedAll = async (n, clip, from, to) => {
      const out = new Array(n).fill(null);
      let next = 0, done = 0;
      const lane = async () => {
        while (next < n) {
          const i = next++;
          out[i] = await speakers.embed(i, clip(i));
          if (++done % 20 === 0 || done === n) onProgress({ stage: 'speakers', progress: from + (to - from) * done / n });
        }
      };
      await Promise.all(Array.from({ length: IN_FLIGHT }, lane));
      return out;
    };
    const times = planWindows(audio);
    const winVectors = await embedAll(times.length, i => audio.slice(Math.round(times[i] * SR), Math.round((times[i] + WIN) * SR)), 0, 0.7);
    pieces = segmentPhrases(phrases, times, winVectors, expectedSpeakers || 0);
    vectors = await embedAll(pieces.length, i => pieceAudio(audio, pieces[i]), 0.7, 1);
  } finally { speakers.close(); }

  onProgress({ stage: 'regroup' });
  const capture = assembleCapture({ phrases, pieces, vectors, expectedSpeakers, durationSec });
  onProgress({ stage: 'done', progress: 1 });
  return capture;
}
