// Mic capture into a rolling 16 kHz mono buffer, with a session clock from AudioContext.currentTime.
// Also the shared windowing constants and the adaptive noise gate (pure, used by live, upload and tools/).

export const SR = 16000;   // model rate
export const WIN = 1.5;    // voiceprint window, seconds
export const HOP = 0.75;   // window hop, seconds

export function rms(x) {
  let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length || 1));
}

// Adaptive RMS noise gate over the last ~2 min of windows: the floor is the 5th percentile.
// A window is voiced if it is 3x the floor, but the bar never rises above 0.4x the median,
// so nonstop talk (no real silence to learn from) isn't gated away. On a podcast with
// reference labels this kept 96% of speech windows (a min-tracking floor kept 33%).
export class NoiseGate {
  constructor({ history = 160, floorRatio = 3, medianRatio = 0.4, minRms = 0.002 } = {}) {
    this.history = history; this.floorRatio = floorRatio; this.medianRatio = medianRatio; this.minRms = minRms; this.recent = [];
  }
  voiced(r) {
    this.recent.push(r);
    if (this.recent.length > this.history) this.recent.shift();
    const s = this.recent.slice().sort((a, b) => a - b);
    this.floor = s[Math.floor(0.05 * s.length)];
    const bar = Math.min(this.floor * this.floorRatio, s[Math.floor(0.5 * s.length)] * this.medianRatio);
    return r >= Math.max(this.minRms, bar);
  }
}

// Worklet: averages input samples into 16 kHz output (box-filter decimation, any input rate),
// posts ~0.128 s blocks with the session frame of the first output sample.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor(o) {
    super(); this.step = sampleRate / ${SR}; this.acc = 0; this.cnt = 0; this.pos = 0;
    this.buf = new Float32Array(2048); this.n = 0; this.outIdx = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      if (this.step === 1) { this.push(ch[i]); continue; }
      this.acc += ch[i]; this.cnt++; this.pos += 1;
      if (this.pos >= this.step) { this.pos -= this.step; this.push(this.acc / this.cnt); this.acc = 0; this.cnt = 0; }
    }
    return true;
  }
  push(v) {
    if (this.n === 0) this.first = currentFrame / sampleRate;
    this.buf[this.n++] = v;
    if (this.n === this.buf.length) {
      this.port.postMessage({ time: this.first, data: this.buf }, [this.buf.buffer]);
      this.buf = new Float32Array(2048); this.n = 0;
    }
  }
}
registerProcessor('dl-tap', Tap);`;

async function openContext(stream) {
  // Ask for 16 kHz directly; some browsers (Firefox) refuse to connect a mic at another rate.
  try {
    const ctx = new AudioContext({ sampleRate: SR });
    const src = ctx.createMediaStreamSource(stream);
    return { ctx, src };
  } catch (e) {
    const ctx = new AudioContext();
    return { ctx, src: ctx.createMediaStreamSource(stream) };
  }
}

// startAudio({ bufferSec }) → { now(), read(t0, t1), level, sampleRate, stop() }
// now(): seconds since start on the audio clock. read(): a copy of [t0, t1) at 16 kHz, or null if not buffered.
export async function startAudio({ bufferSec = 90 } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the microphone.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  });
  const { ctx, src } = await openContext(stream);
  await ctx.resume();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(ctx, 'dl-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);   // keep the node pulled

  const t0 = ctx.currentTime;
  const cap = Math.round(bufferSec * SR), ring = new Float32Array(cap);
  let written = 0, startTime = null;   // session time of output sample 0
  const api = { sampleRate: ctx.sampleRate, level: 0 };

  node.port.onmessage = ({ data: { time, data } }) => {
    if (startTime === null) startTime = time - t0;   // worklet blocks are gapless, so count samples from here
    for (let i = 0; i < data.length; i++) ring[(written + i) % cap] = data[i];
    written += data.length;
    api.level = rms(data);
  };

  api.now = () => ctx.currentTime - t0;
  api.read = (a, b) => {
    if (startTime === null) return null;
    const i0 = Math.round((a - startTime) * SR), i1 = Math.round((b - startTime) * SR);
    if (i0 < 0 || i1 > written || i0 < written - cap || i1 <= i0) return null;
    const out = new Float32Array(i1 - i0);
    for (let i = 0; i < out.length; i++) out[i] = ring[(i0 + i) % cap];
    return out;
  };
  api.stop = async () => {
    node.port.onmessage = null;
    try { src.disconnect(); node.disconnect(); mute.disconnect(); } catch (e) {}
    stream.getTracks().forEach(t => t.stop());
    await ctx.close().catch(() => {});
  };
  return api;
}
