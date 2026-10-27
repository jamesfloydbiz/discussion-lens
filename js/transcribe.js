// Live transcript from the browser's Web Speech API (Chrome/Edge; Chrome sends audio to Google).
// Each final phrase is stamped on the caller's session clock:
//   start = time of its first interim result − LEAD, end = time of the final result.

const LEAD = 0.5;          // interim results arrive ~0.5 s after speech starts
const SEC_PER_WORD = 0.35; // fallback when a phrase goes straight to final

function Recognition() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}

export function speechSupported() { return !!Recognition(); }

export const UNSUPPORTED_MESSAGE =
  'Live transcript needs Chrome or Edge (this browser has no speech recognition). ' +
  'Use "Upload a recording" instead, or switch browsers.';

// startTranscriber({ clock, lang, onPhrase, onInterim, onStatus }) → { stop(): Promise }
// clock() → seconds from session start. onPhrase({ start, end, text }) once per final phrase.
// onStatus({ stage: 'listening'|'restarting'|'error'|'stopped', message? }).
export function startTranscriber({ clock, lang = 'en-US', onPhrase, onInterim, onStatus = () => {} }) {
  const R = Recognition();
  if (!R) { onStatus({ stage: 'error', message: UNSUPPORTED_MESSAGE }); throw new Error(UNSUPPORTED_MESSAGE); }

  let running = true, rec = null, lastStart = 0, quickRestarts = 0, endWaiters = [];
  let firstInterim = new Map();   // result index → session time of its first interim

  function open() {
    rec = new R();
    rec.lang = lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    firstInterim = new Map();   // indices restart with each session

    rec.onresult = ev => {
      const now = clock();
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i], text = r[0].transcript.trim();
        if (!r.isFinal) {
          if (!text) continue;
          if (!firstInterim.has(i)) firstInterim.set(i, now);
          onInterim?.({ text, start: Math.max(0, firstInterim.get(i) - LEAD) });
          continue;
        }
        const seen = firstInterim.get(i);
        firstInterim.delete(i);
        if (!text) continue;
        const words = text.split(/\s+/).length;
        const start = seen !== undefined ? seen - LEAD : now - LEAD - words * SEC_PER_WORD;
        onPhrase({ start: Math.max(0, Math.min(start, now - 0.2)), end: now, text });
      }
    };
    rec.onerror = ev => {
      if (ev.error === 'no-speech' || ev.error === 'aborted') return;   // onend restarts
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        running = false;
        onStatus({ stage: 'error', message: 'Speech recognition was blocked. Allow the microphone for this site and try again.' });
        return;
      }
      if (ev.error === 'network') onStatus({ stage: 'error', message: 'Speech recognition lost its connection (it uses Google\'s service). Retrying…' });
      else onStatus({ stage: 'error', message: 'Speech recognition error: ' + ev.error });
    };
    rec.onend = () => {
      if (!running) { endWaiters.splice(0).forEach(f => f()); onStatus({ stage: 'stopped' }); return; }
      // Chrome ends sessions after silence or ~60 s; restart, backing off if it keeps dying at once.
      quickRestarts = performance.now() - lastStart < 1000 ? quickRestarts + 1 : 0;
      const delay = Math.min(5000, quickRestarts * 500);
      onStatus({ stage: 'restarting' });
      setTimeout(() => { if (running) open(); }, delay);
    };
    lastStart = performance.now();
    try { rec.start(); onStatus({ stage: 'listening' }); }
    catch (e) { onStatus({ stage: 'error', message: 'Speech recognition could not start: ' + e.message }); }
  }
  open();

  return {
    // Stops listening; resolves after the last final result has been delivered (or 2 s).
    stop() {
      if (!running) return Promise.resolve();
      running = false;
      return new Promise(res => {
        endWaiters.push(res);
        setTimeout(res, 2000);
        try { rec.stop(); } catch (e) { res(); }
      });
    },
  };
}
