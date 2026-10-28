import { test, expect } from 'bun:test';
import { workerRpc, openSpeakerModel } from '../js/live.js';
import { openAsr } from '../js/upload.js';

// Stand-in for a Worker: records posts; tests drive replies and crashes by hand.
function mockWorker() {
  return {
    posted: [], terminated: false,
    postMessage(m) { this.posted.push(m); },
    terminate() { this.terminated = true; },
    reply(m) { this.onmessage({ data: m }); },
    crash(message = 'device lost') { this.onerror({ message, preventDefault() {} }); },
  };
}
const settled = p => p.then(v => ({ ok: v }), e => ({ err: e.message }));

test('workerRpc: replies settle by id, error replies reject', async () => {
  const w = mockWorker(), rpc = workerRpc(w, { name: 'W' });
  const a = rpc.call({ type: 'x' }), b = rpc.call({ type: 'x' });
  w.reply({ type: 'done', id: w.posted[1].id, v: 2 });
  w.reply({ type: 'error', id: w.posted[0].id, message: 'bad' });
  expect(await settled(a)).toEqual({ err: 'bad' });
  expect((await b).v).toBe(2);
  expect(rpc.pending()).toBe(0);
});

test('workerRpc: a crash rejects every pending call and later calls, and fires onDead once', async () => {
  const w = mockWorker(), rpc = workerRpc(w, { name: 'W' });
  let deaths = 0; rpc.onDead(() => deaths++);
  const calls = [rpc.call({}), rpc.call({}), rpc.call({})];
  w.crash();
  w.onmessageerror();   // a second failure changes nothing
  for (const c of calls) expect(await settled(c)).toEqual({ err: 'W crashed: device lost' });
  expect(await settled(rpc.call({}))).toEqual({ err: 'W crashed: device lost' });
  expect(deaths).toBe(1);
  expect(rpc.pending()).toBe(0);
});

test('workerRpc: messageerror also kills it', async () => {
  const w = mockWorker(), rpc = workerRpc(w, { name: 'W' });
  const c = rpc.call({});
  w.onmessageerror();
  expect((await settled(c)).err).toMatch(/could not be read/);
});

test('speaker model: crash after ready rejects pending embeds', async () => {
  const w = mockWorker(), model = openSpeakerModel(() => {}, () => w);
  expect(w.posted[0]).toEqual({ type: 'init', cpu: false });
  w.reply({ type: 'ready', device: 'wasm', dim: 256 });
  expect(await model.ready).toEqual({ device: 'wasm', dim: 256 });
  const e1 = model.embed(0, new Float32Array(10)), e2 = model.embed(0.75, new Float32Array(10));
  w.reply({ type: 'embedding', id: w.posted[1].id, t: 0, vector: new Float32Array([1]) });
  expect(Array.from(await e1)).toEqual([1]);
  w.crash('out of memory');
  expect((await settled(e2)).err).toMatch(/out of memory/);
  expect((await settled(model.embed(1.5, new Float32Array(10)))).err).toMatch(/out of memory/);
});

test('speaker model: load error or crash before ready rejects ready', async () => {
  const w1 = mockWorker(), m1 = openSpeakerModel(() => {}, () => w1);
  w1.reply({ type: 'error', message: 'Voice model failed to load: 404' });
  expect((await settled(m1.ready)).err).toMatch(/404/);
  const w2 = mockWorker(), m2 = openSpeakerModel(() => {}, () => w2);
  w2.crash();
  expect((await settled(m2.ready)).err).toMatch(/crashed/);
});

test('whisper client: crash mid-transcribe rejects instead of hanging', async () => {
  const w = mockWorker(), asr = openAsr(() => {}, () => w);
  w.reply({ type: 'ready', device: 'wasm' });
  await asr.ready;
  const job = asr.transcribe(new Float32Array(16000));
  w.crash('GPU device lost');
  expect((await settled(job)).err).toMatch(/GPU device lost/);
});

test('close() rejects pending work and terminates the worker', async () => {
  const w = mockWorker(), model = openSpeakerModel(() => {}, () => w);
  const e = model.embed(0, new Float32Array(10));
  model.close();
  expect((await settled(e)).err).toMatch(/closed/);
  expect(w.terminated).toBe(true);
});
