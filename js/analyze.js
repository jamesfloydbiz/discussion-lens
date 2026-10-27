// Rules-mode analysis: tags → metrics → per-person scores and quality quotes → topics.
// Every threshold below is deliberately simple so the dashboard can explain it.
// Quotes always come from the sentence that carries the move being credited.

import { tagTurns, splitSentences, isQuestion, isClaim, classifyQuestion, reasoningTags, isBuildSentence,
  genericWords, sharedWords, wordCount } from './rules.js';
import { computeMetrics } from './metrics.js';
import { segmentTopics } from './topics.js';
import { quoteSpan } from './quotes.js';
import { levelLabel } from './rubric.js';

const score = (value, basis, evidence) =>
  ({ value, label: levelLabel(value), basis, evidence: evidence.slice(0, 3) });

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Sentences of a turn with their tags: [{ turn, i, sens, text, q, cls, tags }].
function sentencesOf(turn) {
  const sens = splitSentences(turn.text);
  return sens.map((s, i) => {
    const q = isQuestion(s.text);
    return { turn, i, sens, text: s.text, q, claim: isClaim(s.text, q), cls: q ? classifyQuestion(s.text) : null, tags: reasoningTags(s.text, q) };
  });
}

const ref = c => ({ turnId: c.turn.id, quote: quoteSpan(c.turn.text, c.i, c.sens) });

// One quote per turn first, then fill; best-first order is kept.
function spread(cands) {
  const seen = new Set(), first = [], rest = [];
  for (const c of cands) (seen.has(c.turn.id) ? rest : (seen.add(c.turn.id), first)).push(c);
  return [...first, ...rest];
}

// Question quality (Paul & Elder; Graesser & Person; Nystrand).
// null: asked no questions · 1: only factual / yes-no · 2: one deep question
// 3: two or more deep questions · 4: three or more deep questions of at least two kinds.
export function scoreQuestions(turns) {
  const qs = turns.flatMap(sentencesOf).filter(c => c.q);
  if (!qs.length) return score(null, 'Asked no questions.', []);
  const deep = qs.filter(c => c.cls.deep), kinds = new Set(deep.map(c => c.cls.type));
  const value = deep.length >= 3 && kinds.size >= 2 ? 4 : deep.length >= 2 ? 3 : deep.length === 1 ? 2 : 1;
  const seen = new Set();
  const ordered = [...deep.filter(c => !seen.has(c.cls.type) && seen.add(c.cls.type)), ...deep, ...qs];
  const evidence = [...new Map(ordered.map(c => [c.turn.id + c.i, ref(c)])).values()];
  const basis = `${deep.length} of ${plural(qs.length, 'question')} asked why, how, for evidence or another view` +
    (kinds.size ? ` (${[...kinds].join(', ')}).` : '.');
  return score(value, basis, evidence);
}

// Reasoning (Toulmin; Kuhn). Only claim-making sentences count: questions are not claims.
// Claim turn = has a claim sentence (statement of 5+ words taking a stance, not procedure). Grounded = a sentence with a
// reason, evidence, or inference. Rate = grounded / claim turns.
// null: under 2 claim turns · 1: no grounds · 2: one grounded turn, or a counter/concession
// 3: 2+ grounded turns, rate ≥ 40%, 2+ kinds of move
// 4: 2+ grounded turns, rate ≥ 50%, 3+ kinds, and one turn that pairs grounds with a counter or concession.
// A bare "I don't think so" is weaker than a reason; grounds + counter together rank highest.
const WEIGHT = { evidence: 3, reason: 2.5, counter: 2, inference: 2, concession: 1.5, qualifier: 0.5 };
const GROUNDS = ['reason', 'evidence', 'inference'];
const DIALECTIC = ['counter', 'concession'];
const has = (tags, set) => tags.some(t => set.includes(t));

// Strength of one sentence as reasoning evidence: grounds + counter in one sentence ranks highest.
export function strength(tags) {
  const base = tags.reduce((a, t) => a + WEIGHT[t], 0);
  return base + (has(tags, ['reason', 'evidence']) && has(tags, DIALECTIC) ? 2 : 0);
}

export function scoreReasoning(turns) {
  const per = turns.map(t => sentencesOf(t));
  const claimTurns = per.filter(ss => ss.some(c => c.claim));
  if (claimTurns.length < 2) return score(null, `Not enough evidence: ${plural(claimTurns.length, 'turn')} making a claim.`, []);
  const turnTags = ss => [...new Set(ss.flatMap(c => c.tags))];
  const grounded = claimTurns.filter(ss => ss.some(c => !c.q && has(c.tags, GROUNDS))).length;
  const kinds = new Set(claimTurns.flatMap(turnTags));
  const rate = grounded / claimTurns.length;
  const strongTurn = claimTurns.some(ss => { const t = turnTags(ss); return has(t, GROUNDS) && has(t, DIALECTIC); });
  const value = grounded >= 2 && rate >= 0.5 && kinds.size >= 3 && strongTurn ? 4
    : grounded >= 2 && rate >= 0.4 && kinds.size >= 2 ? 3
    : grounded >= 1 || has([...kinds], DIALECTIC) ? 2 : 1;
  const cands = per.flat().filter(c => c.tags.length).sort((a, b) => strength(b.tags) - strength(a.tags));
  const order = ['counter', 'concession', 'evidence', 'reason', 'inference', 'qualifier'];
  const basis = `${grounded} of ${plural(claimTurns.length, 'claim turn')} gave reasons, evidence or inferences` +
    (kinds.size ? `; moves used: ${order.filter(k => kinds.has(k)).join(', ')}.` : '.');
  return score(value, basis, spread(cands).map(ref));
}

// Building on others (Accountable Talk; Demszky et al. 2021 uptake).
// Eligible turn = someone else spoke before it. Linked = explicit link or lexical uptake.
// null: under 2 eligible turns · 1: no links · 2: some links (also the cap under 3 eligible turns)
// 3: links in 40%+ of turns, at least one explicit
// 4: links in 60%+ of turns, 2+ explicit, and one explicit link carries a reason or counter.
export function scoreBuilding(turns, tags, allTurns, speakers = [], generic = new Set()) {
  const firstOther = allTurns.findIndex(t => t.speaker !== turns[0]?.speaker);
  const eligible = turns.filter(t => firstOther >= 0 && allTurns.indexOf(t) > firstOther);
  if (eligible.length < 2) return score(null, 'Too few turns after others spoke.', []);
  const linked = eligible.filter(t => tags[t.id].buildsOn.uptakeFrom || tags[t.id].buildsOn.explicit);
  const explicit = eligible.filter(t => tags[t.id].buildsOn.explicit);
  const rate = linked.length / eligible.length;
  // The sentence that does the linking: an explicit marker / named peer, else most shared words.
  const byId = new Map(allTurns.map(t => [t.id, t]));
  const pick = t => {
    const ss = sentencesOf(t);
    const mark = ss.filter(c => isBuildSentence(c.text, t.speaker, speakers));
    if (mark.length) return mark.sort((a, b) => strength(b.tags) - strength(a.tags))[0];
    const src = byId.get(tags[t.id].buildsOn.uptakeFrom);
    if (!src) return null;
    const best = ss.map(c => [c, sharedWords(c.text, src.text, generic).length]).sort((a, b) => b[1] - a[1])[0];
    return best && best[1] > 0 ? best[0] : null;
  };
  const picks = linked.map(pick).filter(Boolean);
  const reasoned = picks.some(c => explicit.includes(c.turn) && has(c.tags, ['reason', 'evidence', 'counter', 'concession']));
  let value = !linked.length ? 1
    : rate >= 0.6 && explicit.length >= 2 && reasoned ? 4
    : rate >= 0.4 && explicit.length >= 1 ? 3 : 2;
  if (eligible.length < 3) value = Math.min(value, 2);
  picks.sort((a, b) => (isBuildSentence(b.text, b.turn.speaker, speakers) - isBuildSentence(a.text, a.turn.speaker, speakers))
    || strength(b.tags) - strength(a.tags));
  const basis = `Linked to others' ideas in ${linked.length} of ${plural(eligible.length, 'turn')}; ` +
    `${explicit.length} explicit (“I agree with…”, a peer's name, “building on”).`;
  return score(value, basis, picks.map(ref));
}

export function scoreClarity() {
  return score(null, 'Clarity needs the Claude analysis (Paul & Elder intellectual standards).', []);
}

// --- quality quotes ---

const MOVES = {
  counter: [5, 'Counterargument', 'Takes on another view instead of ignoring it (Kuhn).'],
  concession: [4.5, 'Concession', 'Grants a fair point, then keeps reasoning (Toulmin rebuttal).'],
  evidence: [4, 'Evidence', 'Backs a claim with an example or source (Toulmin grounds).'],
  building: [4, 'Builds on others', 'Links to a peer\'s idea and adds to it (Accountable Talk).'],
  inference: [3, 'Draws a conclusion', 'Spells out what follows from the reasons (Toulmin warrant).'],
  reason: [3, 'Gives a reason', 'Backs a claim with a reason (Toulmin grounds).'],
  qualifier: [2, 'Weighs certainty', 'Says how sure they are, or when it applies (Toulmin qualifier).'],
};
const QMOVES = {
  clarification: ['Asks what it means', 'Asks someone to clarify before judging (Paul & Elder).'],
  evidence: ['Asks for evidence', 'Asks how we know, not just what (Paul & Elder).'],
  assumption: ['Questions an assumption', 'Tests what the group is taking for granted (Paul & Elder).'],
  viewpoint: ['Invites other views', 'Opens the floor to other perspectives (Nystrand: authentic question).'],
  implication: ['Asks what follows', 'Pushes on consequences (Paul & Elder: implications).'],
  causal: ['Asks why or how', 'A deep why/how question (Graesser & Person).'],
};

// The move credited is always one this sentence itself carries. A sentence pairing grounds
// with a counter/concession is labelled by the dialectic move (Kuhn).
const LABEL_ORDER = ['counter', 'concession', 'evidence', 'reason', 'inference', 'qualifier'];
function sentenceMove(c, speakers) {
  let v = 0, move = null;
  if (c.q && c.cls.deep) { v = 4; move = QMOVES[c.cls.type]; }
  if (c.tags.length) {
    const dial = has(c.tags, DIALECTIC) && has(c.tags, ['reason', 'evidence', 'inference']);
    const top = dial ? LABEL_ORDER.find(t => c.tags.includes(t))
      : [...c.tags].sort((a, b) => WEIGHT[b] - WEIGHT[a])[0];
    const build = isBuildSentence(c.text, c.turn.speaker, speakers);
    const sv = strength(c.tags) + (build ? 1 : 0);
    if (sv > v) { v = sv; move = build && !dial ? MOVES.building.slice(1) : MOVES[top].slice(1); }
  }
  if (!move) return null;
  const n = wordCount(c.text);
  return { v: v + (n >= 6 && n <= 40 ? 0.5 : 0), ...ref(c), move: move[0], why: move[1] };
}

// 2–3 best moments: highest-value move per turn, one quote per turn.
export function qualityQuotes(turns, speakers = []) {
  const best = [];
  for (const t of turns) {
    const c = sentencesOf(t).map(x => sentenceMove(x, speakers)).filter(Boolean).sort((a, b) => b.v - a.v)[0];
    if (c) best.push(c);
  }
  best.sort((a, b) => b.v - a.v);
  let picks = best.filter(c => c.v >= 3).slice(0, 3);   // ~ a reason, evidence, or deep question
  if (picks.length < 2) picks = best.slice(0, 2);
  return picks.map(({ v, ...q }) => q);
}

export function analyzeRules(session) {
  const turns = session.turns || [], speakers = session.speakers || [];
  const turnTags = tagTurns(turns, speakers);
  const generic = genericWords(turns);
  const metrics = computeMetrics(session, turnTags);
  const people = {};
  for (const id of Object.keys(metrics.perSpeaker)) {
    const mine = turns.filter(t => String(t.speaker) === id);
    people[id] = {
      scores: {
        questions: scoreQuestions(mine),
        reasoning: scoreReasoning(mine),
        building: mine.length ? scoreBuilding(mine, turnTags, turns, speakers, generic) : score(null, 'Did not speak.', []),
        clarity: scoreClarity(),
      },
      quotes: qualityQuotes(mine, speakers),
    };
  }
  return { metrics, turnTags, people, topics: segmentTopics(session) };
}
