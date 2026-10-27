// Participation metrics (exact counts from turns; no judgement involved).

import { wordCount, endsWithQuestion, tagTurns } from './rules.js';

export const QUICK_TAKEOVER_SEC = 0.3;   // next speaker starts within 0.3 s of a non-question turn

// Gini coefficient of talk time: 0 = everyone equal, 1 = one person talks.
export function gini(values) {
  const n = values.length, sum = values.reduce((a, b) => a + b, 0);
  if (n < 2 || sum <= 0) return 0;
  let d = 0;
  for (const a of values) for (const b of values) d += Math.abs(a - b);
  return d / (2 * n * sum);
}

const round = (x, p = 2) => Math.round(x * 10 ** p) / 10 ** p;

export function computeMetrics(session, turnTags = tagTurns(session.turns, session.speakers)) {
  const turns = session.turns || [];
  const ids = new Set((session.speakers || []).map(s => s.id));
  turns.forEach(t => ids.add(t.speaker));
  const perSpeaker = {}, respondsTo = {};
  for (const id of ids) {
    perSpeaker[id] = { talkSec: 0, share: 0, turns: 0, words: 0, avgTurnSec: 0, avgTurnWords: 0,
      questions: 0, deepQuestions: 0, quickTakeovers: 0 };
    respondsTo[id] = {};
  }
  turns.forEach((t, i) => {
    const p = perSpeaker[t.speaker];
    p.talkSec += Math.max(0, t.end - t.start);
    p.turns++;
    p.words += wordCount(t.text);
    const qs = turnTags[t.id]?.questions || [];
    p.questions += qs.length;
    p.deepQuestions += qs.filter(q => q.deep).length;
    const prev = turns[i - 1];
    if (prev && prev.speaker !== t.speaker) {
      respondsTo[prev.speaker][t.speaker] = (respondsTo[prev.speaker][t.speaker] || 0) + 1;
      if (t.start - prev.end < QUICK_TAKEOVER_SEC && !endsWithQuestion(prev.text)) p.quickTakeovers++;
    }
  });
  const totalTalkSec = Object.values(perSpeaker).reduce((a, p) => a + p.talkSec, 0);
  for (const p of Object.values(perSpeaker)) {
    p.share = totalTalkSec ? round(p.talkSec / totalTalkSec, 4) : 0;
    p.avgTurnSec = p.turns ? round(p.talkSec / p.turns) : 0;
    p.avgTurnWords = p.turns ? round(p.words / p.turns, 1) : 0;
    p.talkSec = round(p.talkSec);
  }
  return {
    totalTalkSec: round(totalTalkSec),
    gini: round(gini(Object.values(perSpeaker).map(p => p.talkSec)), 3),
    perSpeaker, respondsTo,
  };
}
