// Live session: mic → voiced 1.5 s windows → voiceprints (worker) → live speaker labels,
// plus the Web Speech transcript. stop() regroups every voiceprint and returns a Capture.
import { startAudio, NoiseGate, rms, WIN, HOP } from './audio.js';
import { startTranscriber, speechSupported, UNSUPPORTED_MESSAGE } from './transcribe.js';
import { OnlineClusterer, regroup } from './clustering.js';

// Request/response over a worker, shared with upload.js. Requests carry an id; a reply with that id
// settles it ({type:'error'} rejects). If the worker crashes (error / messageerror, e.g. WebGPU device
// lost, out of memory) every pending request rejects, later calls reject at once, and onDead fires.
export function workerRpc(worker, { name = 'Worker', onOther = () => {} } = {}) {
  const waiting = new Map(), deadHandlers = [];
  let nextId = 1, dead = null;
  const fail = err => {
    if (dead) return;
    dead = err;
    waiting.forEach(w => w.rej(err)); waiting.clear();
    deadHandlers.splice(0).forEach(f => f(err));
  };
  worker.onmessage = ({ data: m }) => {
    if (m && m.id !== undefined && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      if (m.type === 'error') w.rej(new Error(m.message)); else w.res(m);
      return;
    }
    onOther(m);
  };
  worker.onerror = e => { e?.preventDefault?.(); fail(new Error(name + ' crashed: ' + (e?.message || 'unknown error'))); };
  worker.onmessageerror = () => fail(new Error(name + ' sent a message that could not be read'));
  return {
    call(msg, transfer = []) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      return new Promise((res, rej) => {
        waiting.set(id, { res, rej });
        try { worker.postMessage({ ...msg, id }, transfer); } catch (e) { waiting.delete(id); rej(e); }
      });
    },
    send(msg, transfer = []) { if (!dead) worker.postMessage(msg, transfer); },   // no reply expected
    fail,
    onDead(f) { if (dead) f(dead); else deadHandlers.push(f); },
    get dead() { return dead; },
    pending: () => waiting.size,
    close() { fail(new Error(name + ' closed')); worker.terminate(); },
  };
}

// Speaker worker client, shared with upload.js.
// openSpeakerModel(onProgress) → { ready: Promise<{device, dim}>, embed(t, audio) → Promise<Float32Array>, onDead(f), close() }
// `ready` and every pending embed reject if the worker fails at any point.
export function openSpeakerModel(onProgress = () => {}, makeWorker = () => new Worker(new URL('./speakers.worker.js', import.meta.url), { type: 'module' })) {
  const files = {};
  let readyRes, readyRej;
  const ready = new Promise((res, rej) => { readyRes = res; readyRej = rej; });
  ready.catch(() => {});
  const rpc = workerRpc(makeWorker(), {
    name: 'Voice model worker',
    onOther(m) {
      if (m.type === 'progress') {
        if (m.file) files[m.file] = { loaded: m.loaded ?? (m.status === 'done' ? files[m.file]?.total : 0) ?? 0, total: m.total ?? files[m.file]?.total ?? 0 };
        const fs = Object.values(files), total = fs.reduce((n, f) => n + (f.total || 0), 0);
        const loaded = fs.reduce((n, f) => n + (f.loaded || 0), 0);
        onProgress({ stage: 'speaker-model', loaded, total, progress: total ? loaded / total : 0 });
      } else if (m.type === 'ready') { readyRes({ device: m.device, dim: m.dim }); onProgress({ stage: 'speaker-model', progress: 1, device: m.device }); }
      else if (m.type === 'error') rpc.fail(new Error(m.message));   // load failure: nothing will work
    },
  });
  rpc.onDead(readyRej);
  rpc.send({ type: 'init' });
  return {
    ready,
    embed: (t, audio) => rpc.call({ type: 'embed', t, audio }, [audio.buffer]).then(m => m.vector),
    onDead: f => rpc.onDead(f),
    pending: () => rpc.pending(),
    close: () => rpc.close(),
  };
}

// Majority speaker (by overlap time) of the windows that overlap [start, end]; null if none.
export function majoritySpeaker(windows, start, end) {
  const tot = new Map();
  for (const w of windows) {
    if (w.speaker === null || w.speaker === undefined) continue;
    const o = Math.min(end, w.t + w.dur) - Math.max(start, w.t);
    if (o > 0) tot.set(w.speaker, (tot.get(w.speaker) || 0) + o);
  }
  let best = null, bo = 0;
  tot.forEach((o, s) => { if (o > bo) { bo = o; best = s; } });
  return best;
}

// Pack vectors as { dim, data } for storage.
export function packEmbeddings(vectors) {
  const dim = vectors[0]?.length || 0, data = new Float32Array(vectors.length * dim);
  vectors.forEach((v, i) => data.set(v, i * dim));
  return { dim, data };
}

const MAX_IN_FLIGHT = 2;      // worker jobs at once; more waiting windows are kept and sent newest-first
const PHRASE_WAIT_MS = 2500;  // let the phrase's last windows get embedded before labelling it
const MAX_QUEUED = 800;       // ~10 min of speech (~75 MB) held while the model downloads
const READY_WAIT_MS = 20000; // on Stop, how long to wait for a still-downloading voice model
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REGROUP_EVERY = 15;     // s: relabel the live view with the full regroup (the online clusterer under-splits)

// startLive({ expectedSpeakers, onPhrase, onStatus, lang }) → { stop(): Promise<Capture> }
// onStatus({ stage, … }): 'mic' | 'speaker-model' (progress) | 'listening' | 'warning' | 'error' | 'finishing' | 'done',
// plus { stage: 'speakers', live: [{ speaker, talkSec }] } after each labelled window.
export async function startLive({ expectedSpeakers = 0, onPhrase = () => {}, onStatus = () => {}, lang = 'en-US' } = {}) {
  onStatus({ stage: 'mic' });
  const audio = await startAudio();
  const model = openSpeakerModel(p => onStatus(p));
  let modelOk = true;
  let closing = false;
  model.onDead(e => {
    const was = modelOk;
    modelOk = false;   // pump() stops sending and the finishing loop exits
    if (was && !closing) onStatus({ stage: 'error', message: e.message + ' Speakers will not be separated from here on.' });
  });

  const clusterer = new OnlineClusterer();
  const windows = [], vectors = [], phrases = [], talk = new Map();
  const queued = [];   // voiced windows waiting for the worker: { t, audio }
  const voicedTimes = [];   // every voiced window, embedded or not
  let inFlight = 0, nextT = 0, phraseN = 0, running = true;
  const gate = new NoiseGate();

  function pump() {
    if (!modelOk) queued.length = 0;
    while (modelOk && inFlight < MAX_IN_FLIGHT && queued.length) {
      const job = queued.pop();   // newest first keeps live labels current
      inFlight++;
      model.embed(job.t, job.audio).then(v => {
        const speaker = clusterer.add(v);
        windows.push({ t: job.t, dur: WIN, speaker }); vectors.push(v);
        talk.set(speaker, (talk.get(speaker) || 0) + HOP);
        onStatus({ stage: 'speakers', live: [...talk].map(([speaker, talkSec]) => ({ speaker, talkSec })) });
      }, () => {}).finally(() => { inFlight--; pump(); });
    }
  }

  // Every hop: take each new window on the hop grid (catches up after timer throttling), skip silence.
  function tick() {
    const now = audio.now();
    while (nextT + WIN <= now - 0.05) {
      const a = audio.read(nextT, nextT + WIN);
      if (a && gate.voiced(rms(a))) { queued.push({ t: nextT, audio: a }); voicedTimes.push(nextT); }
      if (queued.length > MAX_QUEUED) queued.shift();
      nextT = Math.round(nextT / HOP + 1) * HOP;
    }
    pump();
  }
  const timer = setInterval(tick, HOP * 1000);

  // Periodic full regroup so live colours match what the final dashboard will show.
  let lastRegroup = 0;
  function relabel() {
    if (windows.length < 40 || audio.now() - lastRegroup < REGROUP_EVERY) return;
    lastRegroup = audio.now();
    const order = windows.map((w, i) => i).sort((a, b) => windows[a].t - windows[b].t);
    const labels = regroup(order.map(i => vectors[i]), { k: expectedSpeakers || 0 });
    order.forEach((i, j) => { windows[i].speaker = labels[j]; });
    talk.clear();
    for (const w of windows) talk.set(w.speaker, (talk.get(w.speaker) || 0) + HOP);
    onStatus({ stage: 'relabel', phrases: phrases.map(p => ({ id: p.id, speaker: majoritySpeaker(windows, p.start, p.end) })) });
  }
  const regroupTimer = setInterval(relabel, 5000);

  const labelLater = [];
  function addPhrase(p) {
    const phrase = { id: 'p' + (++phraseN), start: p.start, end: p.end, text: p.text, source: 'webspeech' };
    phrases.push(phrase);
    const h = setTimeout(() => {
      labelLater.splice(labelLater.indexOf(h), 1);
      onPhrase({ ...phrase, speaker: majoritySpeaker(windows, phrase.start, phrase.end) });
    }, PHRASE_WAIT_MS);
    labelLater.push(h);
  }

  let asr = null;
  if (!speechSupported()) onStatus({ stage: 'warning', message: UNSUPPORTED_MESSAGE });
  else {
    try { asr = startTranscriber({ clock: () => audio.now(), lang, onPhrase: addPhrase, onStatus: s => onStatus({ ...s, source: 'speech' }) }); }
    catch (e) { onStatus({ stage: 'warning', message: e.message }); }
  }

  return {
    async stop() {
      if (!running) throw new Error('already stopped');
      running = false;
      onStatus({ stage: 'finishing', message: 'Finishing the transcript…' });
      await asr?.stop();
      clearInterval(timer); clearInterval(regroupTimer);
      tick();
      const durationSec = audio.now();
      await audio.stop();
      // Embed every voiced window still waiting, so the final regroup sees all of them.
      // Bounded: a first-run download may still be going, and the worker may die (that rejects every pending embed).
      if (modelOk) {
        const loaded = await Promise.race([model.ready.then(() => true, () => false), sleep(READY_WAIT_MS).then(() => false)]);
        if (!loaded && modelOk) {
          modelOk = false;
          onStatus({ stage: 'warning', message: 'The voice model had not finished loading, so this session has no speaker separation (all speech is one speaker).' });
        }
        const total = queued.length + inFlight;
        while (modelOk && (queued.length || inFlight)) {
          onStatus({ stage: 'finishing', message: 'Matching voices…', progress: total ? 1 - (queued.length + inFlight) / total : 1 });
          pump();
          await sleep(100);
        }
      }
      closing = true; model.close();
      labelLater.splice(0).forEach(clearTimeout);

      // Final regroup over every voiceprint, in time order.
      const order = windows.map((w, i) => i).sort((a, b) => windows[a].t - windows[b].t);
      const vs = order.map(i => vectors[i]);
      const labels = regroup(vs, { k: expectedSpeakers || 0 });
      // No voiceprints at all (model never loaded or died at once): every voiced window is speaker 0.
      const finalWindows = vs.length ? order.map((i, j) => ({ t: windows[i].t, dur: WIN, speaker: labels[j] }))
        : voicedTimes.sort((a, b) => a - b).map(t => ({ t, dur: WIN, speaker: 0 }));
      onStatus({ stage: 'done' });
      return { phrases, windows: finalWindows, embeddings: packEmbeddings(vs), durationSec };
    },
  };
}
