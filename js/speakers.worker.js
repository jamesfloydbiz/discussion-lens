// Voiceprint worker (module worker). 16 kHz mono windows in, L2-normalised 256-d WeSpeaker embeddings out.
// in:  {type:'init', cpu?: true} · {type:'embed', id, t, audio: Float32Array}
// out: {type:'progress', file, status, loaded, total, progress} · {type:'ready', device, dim}
//      {type:'embedding', id, t, vector} · {type:'error', id?, message}
import { AutoModel, AutoFeatureExtractor, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

const MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';   // spike: 96.7% on 2 real speakers
env.allowLocalModels = false;

let model = null, fe = null, loading = null;

function normalize(v) {
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return Float32Array.from(v, x => x / n);
}

async function embed(audio) {
  const out = await model(await fe(audio));
  return normalize(out.last_hidden_state.data);   // WeSpeaker's only output: [1, 256]
}

async function load(cpu) {
  const progress_callback = p => { if (p.status === 'progress' || p.status === 'done') self.postMessage({ type: 'progress', ...p }); };
  fe = await AutoFeatureExtractor.from_pretrained(MODEL);
  const hasGpu = !cpu && !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
  for (const device of hasGpu ? ['webgpu', 'wasm'] : ['wasm']) {
    try {
      model = await AutoModel.from_pretrained(MODEL, { dtype: 'fp32', device, progress_callback });
      const v = await embed(new Float32Array(24000).map((_, i) => 0.05 * Math.sin(i / 7)));   // warm-up, also catches unsupported ops
      if (v.some(x => !Number.isFinite(x))) throw new Error('non-finite output on ' + device);
      self.postMessage({ type: 'ready', device, dim: v.length });
      return;
    } catch (e) {
      model = null;
      if (device === 'wasm') throw e;
    }
  }
}

// Embeds run one at a time, in arrival order.
let queue = Promise.resolve();
self.onmessage = ({ data: msg }) => {
  if (msg.type === 'init') {
    loading ||= load(msg.cpu).then(() => true, e => {
      loading = null;   // a later init may retry
      self.postMessage({ type: 'error', message: 'Voice model failed to load: ' + e.message });
      return false;
    });
    return;
  }
  if (msg.type === 'embed') {
    queue = queue.then(async () => {
      try {
        if (!(await loading)) throw new Error('voice model is not loaded');
        const vector = await embed(msg.audio);
        self.postMessage({ type: 'embedding', id: msg.id, t: msg.t, vector }, [vector.buffer]);
      } catch (e) {
        self.postMessage({ type: 'error', id: msg.id, message: e.message });
      }
    });
  }
};
