import { test, expect, describe } from 'bun:test';
import { isQuestion, classifyQuestion, reasoningTags, splitSentences, tagTurns, isBuildSentence } from '../js/rules.js';
import { computeMetrics, gini } from '../js/metrics.js';
import { segmentTopics } from '../js/topics.js';
import { verifyQuote, cleanAnalysis, bestSentence } from '../js/quotes.js';
import { analyzeRules, strength } from '../js/analyze.js';
import { RUBRIC, AGE_BANDS } from '../js/rubric.js';
import { analyzeWithClaude, transcriptLines, buildRequest, DEFAULT_MODEL } from '../js/claude.js';

const session = await Bun.file(new URL('./fixtures/transcript.json', import.meta.url)).json();
const sample = await Bun.file(new URL('../data/sample-session.json', import.meta.url)).json();

// Hand-labelled sentences. q = is it a question; type = Paul & Elder type (deep follows from type);
// tags = reasoning moves expected (exact set). Many have no punctuation, as Web Speech gives them.
const LABELLED = [
  // questions, punctuated
  { s: 'What do you mean by fair?', q: true, type: 'clarification' },
  { s: 'Can you give an example of that?', q: true, type: 'clarification' },
  { s: 'How do you know that?', q: true, type: 'evidence' },
  { s: 'Why do you think the author did that?', q: true, type: 'evidence' },
  { s: 'Are you assuming everyone has a phone?', q: true, type: 'assumption' },
  { s: 'What would happen if there were no rules at all?', q: true, type: 'implication' },
  { s: 'Does anyone disagree?', q: true, type: 'viewpoint' },
  { s: 'Why did the ice melt so fast?', q: true, type: 'causal' },
  { s: 'Who wrote the book?', q: true, type: 'factual' },
  { s: 'Is it on page ten?', q: true, type: 'yesno' },
  { s: 'When did the war start?', q: true, type: 'factual' },
  { s: 'Did you finish the reading?', q: true, type: 'yesno' },
  // questions, raw speech-to-text (no punctuation)
  { s: 'so what do you mean by that', q: true, type: 'clarification' },
  { s: 'what makes you say that', q: true, type: 'evidence' },
  { s: 'where in the text does it say that', q: true, type: 'evidence' },
  { s: 'what if the main character never left home', q: true, type: 'implication' },
  { s: 'do you think it was fair to the other team', q: true, type: 'viewpoint' },
  { s: 'um how come the plants died', q: true, type: 'causal' },
  { s: 'i wonder why they chose that ending', q: true, type: 'causal' },
  { s: 'like how many people live there', q: true, type: 'factual' },
  { s: 'is that the right answer', q: true, type: 'yesno' },
  { s: 'what about people who can not afford it', q: true, type: 'viewpoint' },
  { s: 'is that always true though', q: true, type: 'assumption' },
  { s: 'how does that affect the poor families', q: true, type: 'implication' },
  { s: 'can we move on', q: true, type: 'yesno' },
  { s: 'what year was that', q: true, type: 'factual' },
  // statements (some start with wh-words or fillers)
  { s: 'I think the ending was sad because the dog died.', q: false, tags: ['reason'] },
  { s: 'what i think is that the town was scared', q: false, tags: [] },
  { s: 'when we went to the museum we saw the fossils', q: false, tags: [] },
  { s: 'so like the book was really long you know', q: false, tags: [] },
  { s: 'like i said it was good', q: false, tags: [] },
  { s: 'for example in chapter three he lies to his mom', q: false, tags: ['evidence'] },
  { s: 'it was cold so the pond froze over', q: false, tags: ['inference'] },
  { s: 'maybe it depends on the person', q: false, tags: ['qualifier'] },
  { s: 'I disagree because the rules were already unfair.', q: false, tags: ['reason', 'counter'] },
  { s: 'that is true but the data says most kids sleep less', q: false, tags: ['evidence', 'concession'] },
  { s: 'on the other hand the school needs money', q: false, tags: ['counter'] },
  { s: 'yeah so um I agree', q: false, tags: [] },
  { s: 'the article says thirty percent of kids skip breakfast', q: false, tags: ['evidence'] },
  { s: "if it's raining then the game gets cancelled", q: false, tags: ['inference'] },
  { s: "that's why the colonists were so angry", q: false, tags: ['reason'] },
  { s: 'even though he was nice he still lied', q: false, tags: ['concession'] },
  { s: 'how it works is the water goes up the roots', q: false, tags: [] },
  // second batch, written as a held-out check (first run: 15/20 before the rules were generalised)
  { s: 'why would the author make him the villain', q: true, type: 'causal' },
  { s: 'what evidence do we have that it worked', q: true, type: 'evidence' },
  { s: 'could you explain that part again', q: true, type: 'clarification' },
  { s: 'are we sure that is what happened', q: true, type: 'assumption' },
  { s: 'what would that mean for the kids who walk to school', q: true, type: 'implication' },
  { s: 'how do other people see this', q: true, type: 'viewpoint' },
  { s: 'where is the library', q: true, type: 'factual' },
  { s: 'does the story take place in winter', q: true, type: 'yesno' },
  { s: 'okay so who has the next question', q: true, type: 'factual' },
  { s: 'what she did was brave', q: false, tags: [] },
  { s: 'how about we vote', q: true, type: 'yesno' },
  { s: 'so basically the main idea is friendship', q: false, tags: [] },
  { s: 'i feel like the teacher was being unfair', q: false, tags: [] },
  { s: 'who cares', q: true, type: 'factual' },
  { s: 'why not just ask the principal', q: true, type: 'causal' },
  { s: 'you think that is fair', q: true, type: 'viewpoint' },
  { s: 'the reason is that nobody wanted to go first', q: false, tags: ['reason'] },
  { s: 'it says on page forty that he was scared', q: false, tags: ['evidence'] },
  { s: 'but couldnt it also be that she was tired', q: true, type: 'yesno' },
  { s: 'when you think about it they had no choice', q: false, tags: [] },
];

function check(item) {
  const q = isQuestion(item.s);
  const got = { q };
  let ok = q === item.q;
  if (item.type) {
    const c = classifyQuestion(item.s);
    Object.assign(got, c);
    const deep = !['factual', 'yesno'].includes(item.type);
    ok = ok && c.type === item.type && c.deep === deep;
  }
  if (item.tags) {
    const t = reasoningTags(item.s);
    got.tags = t;
    ok = ok && t.length === item.tags.length && item.tags.every(x => t.includes(x));
  }
  return { ok, got };
}

describe('rules classifier', () => {
  test('hand-labelled accuracy >= 85%', () => {
    expect(LABELLED.length).toBeGreaterThanOrEqual(30);
    const results = LABELLED.map(it => ({ it, ...check(it) }));
    const correct = results.filter(r => r.ok).length;
    const acc = correct / LABELLED.length;
    const unpunct = results.filter(r => !/[.?!]$/.test(r.it.s));
    const accU = unpunct.filter(r => r.ok).length / unpunct.length;
    console.log(`classifier accuracy: ${correct}/${LABELLED.length} = ${(acc * 100).toFixed(1)}%` +
      ` (unpunctuated ${(accU * 100).toFixed(1)}% of ${unpunct.length})`);
    for (const r of results.filter(r => !r.ok)) console.log('  miss:', r.it.s, JSON.stringify(r.got));
    expect(acc).toBeGreaterThanOrEqual(0.85);
  });

  test('fillers are not reasoning', () => {
    expect(reasoningTags('so like you know it was fun')).toEqual([]);
    expect(reasoningTags('I think so')).toEqual([]);
  });

  test('splits a run-on with a question in it, as exact substrings', () => {
    const text = "i think it's the sun why do you think it's the moon";
    const s = splitSentences(text);
    expect(s.length).toBe(2);
    for (const x of s) expect(text.slice(x.start, x.end)).toBe(x.text);
    expect(isQuestion(s[1].text)).toBe(true);
    expect(isQuestion(s[0].text)).toBe(false);
  });
});

describe('metrics', () => {
  const tags = tagTurns(session.turns, session.speakers);
  const m = computeMetrics(session, tags);

  test('talk share, turns and words add up', () => {
    const per = Object.values(m.perSpeaker);
    expect(per.reduce((a, p) => a + p.turns, 0)).toBe(session.turns.length);
    expect(per.reduce((a, p) => a + p.share, 0)).toBeCloseTo(1, 2);
    expect(m.perSpeaker[3].share).toBeLessThan(0.15);           // Sam is the quiet one
    expect(m.perSpeaker[3].turns).toBe(6);
    expect(m.perSpeaker[0].avgTurnWords).toBeGreaterThan(m.perSpeaker[3].avgTurnWords);
  });

  test('questions, quick takeovers, respondsTo', () => {
    expect(m.perSpeaker[0].deepQuestions).toBeGreaterThanOrEqual(3);    // Maya probes
    expect(m.perSpeaker[3].deepQuestions).toBe(0);
    // t10 starts 0.15 s after Maya's statement t9 → quick takeover by Leo
    expect(m.perSpeaker[1].quickTakeovers).toBeGreaterThanOrEqual(1);
    // t12 → t13: Sam spoke right after Maya
    expect(m.respondsTo[0][3]).toBeGreaterThanOrEqual(1);
    const pairs = Object.values(m.respondsTo).flatMap(o => Object.values(o)).reduce((a, b) => a + b, 0);
    expect(pairs).toBe(session.turns.length - 1);                       // every change of speaker counted
  });

  test('gini', () => {
    expect(gini([1, 1, 1, 1])).toBe(0);
    expect(gini([0, 0, 0, 10])).toBeCloseTo(0.75, 5);
    expect(m.gini).toBeGreaterThan(0.1);
    expect(m.gini).toBeLessThan(0.5);
  });
});

describe('rules analysis', () => {
  const r = analyzeRules(session);

  test('scores are 1-4 or null, with verbatim evidence', () => {
    const byId = new Map(session.turns.map(t => [t.id, t]));
    for (const p of Object.values(r.people)) {
      expect(p.scores.clarity.value).toBeNull();
      for (const s of Object.values(p.scores)) {
        expect(s.value === null || [1, 2, 3, 4].includes(s.value)).toBe(true);
        expect(s.evidence.length).toBeLessThanOrEqual(3);
        for (const e of s.evidence) expect(byId.get(e.turnId).text.includes(e.quote)).toBe(true);
      }
      for (const q of p.quotes) {
        expect(byId.get(q.turnId).text.includes(q.quote)).toBe(true);
        expect(q.move && q.why).toBeTruthy();
      }
    }
    expect(r.people[0].scores.questions.value).toBeGreaterThanOrEqual(3);
    expect(r.people[3].scores.questions.value).toBe(1);
    expect(r.people[2].quotes.length).toBeGreaterThanOrEqual(2);
  });

  test('topics: at least 2 segments with titles, drivers and key quotes', () => {
    const topics = segmentTopics(session);
    console.log('topics:', topics.map(t => `${t.title} [${t.start}-${t.end}s]`).join(' | '));
    expect(topics.length).toBeGreaterThanOrEqual(2);
    expect(topics.flatMap(t => t.turnIds).length).toBe(session.turns.length);
    for (const t of topics) {
      expect(t.keywords.length).toBeGreaterThan(0);
      expect(t.drivers.length).toBeGreaterThan(0);
      expect(session.turns.find(x => x.id === t.keyQuote.turnId).text.includes(t.keyQuote.quote)).toBe(true);
    }
    expect(topics[topics.length - 1].keywords).toContain('homework');
  });
});

describe('quotes carry the move they are tagged with (sample session)', () => {
  const r = analyzeRules(sample);
  const name = id => sample.speakers.find(s => String(s.id) === String(id)).name;
  const byId = new Map(sample.turns.map(t => [t.id, t]));
  const MOVE_TAG = { Counterargument: 'counter', Concession: 'concession', Evidence: 'evidence',
    'Gives a reason': 'reason', 'Draws a conclusion': 'inference', 'Weighs certainty': 'qualifier' };
  const sens = q => splitSentences(q).map(x => x.text);

  test('every quality quote contains a sentence with its move', () => {
    for (const [id, p] of Object.entries(r.people)) for (const q of p.quotes) {
      const ss = sens(q.quote);
      let ok;
      if (MOVE_TAG[q.move]) ok = ss.some(x => reasoningTags(x).includes(MOVE_TAG[q.move]));
      else if (q.move === 'Builds on others') ok = ss.some(x => isBuildSentence(x, Number(id), sample.speakers));
      else ok = ss.some(x => isQuestion(x) && classifyQuestion(x).deep);
      if (!ok) console.log('mismatch', name(id), q.move, q.quote);
      expect(ok).toBe(true);
    }
  });

  test('reasoning evidence sentences carry a reasoning move; building evidence links', () => {
    for (const [id, p] of Object.entries(r.people)) {
      for (const e of p.scores.reasoning.evidence) expect(sens(e.quote).some(x => reasoningTags(x).length > 0)).toBe(true);
    }
    const leo = r.people[3];
    expect(leo.quotes.some(q => q.quote === "She's the worst character in the story.")).toBe(false);
    for (const e of leo.scores.building.evidence) expect(e.quote).not.toBe("I think she's selfish.");
    expect(leo.scores.building.evidence[0].quote).toContain('Jonah');
  });

  test('strong reasoning is backed by the strongest sentence first', () => {
    const jonah = r.people[1].scores.reasoning;
    expect(jonah.value).toBe(4);
    const top = sens(jonah.evidence[0].quote).map(x => reasoningTags(x)).sort((a, b) => strength(b) - strength(a))[0];
    expect(top.some(t => ['reason', 'evidence'].includes(t))).toBe(true);
    expect(jonah.evidence[0].quote).not.toBe("But I don't think she really grew.");
  });

  test('whole sentences, not comma fragments; 8–40 words unless the turn is shorter', () => {
    const all = Object.values(r.people).flatMap(p => [...p.quotes, ...Object.values(p.scores).flatMap(s => s.evidence)]);
    for (const q of all) {
      const n = q.quote.split(/\s+/).length;
      expect(/[,;:]$/.test(q.quote)).toBe(false);
      expect(n).toBeLessThanOrEqual(40);
      if (byId.get(q.turnId).text.split(/\s+/).length >= 8) expect(n).toBeGreaterThanOrEqual(8);
    }
    expect(all.some(q => q.quote.startsWith('But if Maupassant wanted us to just hate her, why'))).toBe(true);
  });

  test('embedded "why" clause is not a question', () => {
    const t12 = "Interesting. Maya's asking why the narrator spends so much time in her head. Let's hold that.";
    expect(splitSentences(t12).length).toBe(3);
    expect(splitSentences(t12).filter(x => isQuestion(x.text)).length).toBe(0);
    const teacherQuotes = [...r.people[0].quotes, ...r.people[0].scores.questions.evidence];
    expect(teacherQuotes.some(q => q.quote.startsWith('why the narrator'))).toBe(false);
  });

  test('reasoning counts claims, not questions; building has a small-sample guard', () => {
    expect(r.people[4].scores.reasoning.value).toBeNull();                 // Priya: under 2 claim turns
    expect(r.people[0].scores.reasoning.basis).not.toContain('13');        // Teacher's questions not counted
    expect(r.people[4].scores.building.value).toBeLessThanOrEqual(2);      // Priya: 3 turns, 1 link
    expect(r.people[3].scores.building.value).toBeLessThanOrEqual(2);      // Leo: few real links
    const one = { ...sample, turns: sample.turns.slice(0, 4) };
    const b = analyzeRules(one).people[3].scores.building;                 // Leo: 2 eligible turns
    expect(b.value === null || b.value <= 2).toBe(true);
  });
});

describe('quotes', () => {
  const turns = session.turns;

  test('verifyQuote accepts verbatim (ignoring case/punctuation) and rejects made-up', () => {
    const t = turns[1].text;
    expect(verifyQuote('people are on their phones in class', t)).toBe('people are on their phones in class');
    expect(verifyQuote('PEOPLE are on their phones, in class', t)).toBe('people are on their phones in class');
    expect(verifyQuote('phones should be banned because they are addictive', t)).toBeNull();
    expect(verifyQuote('eople are on', t)).toBeNull();          // partial word
  });

  test('cleanAnalysis strips a made-up quote and drops a score left with no evidence', () => {
    const fake = { turnId: 't2', quote: 'Phones rot your brain, says science.' };
    const analysis = {
      people: { 1: {
        scores: {
          questions: { value: 2, label: 'Developing', basis: 'x', evidence: [fake] },
          reasoning: { value: 3, label: 'Proficient', basis: 'x', evidence: [fake, { turnId: 't2', quote: 'because people are on their phones in class' }] },
          building: { value: null, label: 'Not enough evidence', basis: 'x', evidence: [] },
          clarity: { value: 3, label: 'Proficient', basis: 'x', evidence: [{ turnId: 't99', quote: 'I guess I don\'t know for sure' }] },
        },
        quotes: [{ ...fake, move: 'Evidence', why: 'x' }],
        strength: { text: 'x', ...fake }, nextStep: null,
      } },
      topics: [{ id: 'topic1', turnIds: ['t1', 't2'], keyQuote: fake }],
    };
    const c = cleanAnalysis(analysis, turns);
    const p = c.people[1];
    expect(p.scores.questions.value).toBeNull();
    expect(p.scores.reasoning.value).toBe(3);
    expect(p.scores.reasoning.evidence).toEqual([{ turnId: 't2', quote: 'because people are on their phones in class' }]);
    expect(p.scores.clarity.evidence[0].turnId).toBe('t6');     // wrong id recovered from the speaker's own turns
    expect(p.quotes).toEqual([]);
    expect(p.strength).toBeNull();
    expect(c.topics[0].keyQuote).toBeNull();
    expect(c.droppedQuotes).toBe(5);
  });

  test('bestSentence returns a substring', () => {
    const t = turns[13].text;
    expect(t.includes(bestSentence(t))).toBe(true);
  });
});

describe('rubric', () => {
  test('4 anchors per band per dimension, with citations', () => {
    for (const r of RUBRIC) {
      expect(r.basis.length).toBeGreaterThan(0);
      for (const b of AGE_BANDS) expect(r.anchors[b.key].length).toBe(4);
    }
  });
});

describe('claude.js (mocked fetch)', () => {
  const sse = events => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const goodJson = {
    summary: 'Students debated a phone ban, then weekend homework.',
    topics: [
      { title: 'Phone ban', summary: 's', keywords: ['phones'], startTurn: 't1', endTurn: 't17', drivers: [0, 2],
        keyQuote: { turnId: 't3', quote: 'But what about emergencies like if your parents need to reach you' } },
      { title: 'Homework', summary: 's', keywords: ['homework'], startTurn: 't18', endTurn: 't32', drivers: [1],
        keyQuote: { turnId: 't20', quote: 'Homework is a crime against childhood' } },
    ],
    people: [{
      speaker: 0,
      scores: {
        questions: { value: 4, basis: 'b', evidence: [{ turnId: 't5', quote: 'How do you know the office would actually get the message to you in time?' }] },
        reasoning: { value: 3, basis: 'b', evidence: [{ turnId: 't28', quote: 'I invented this sentence completely' }] },
        building: { value: 3, basis: 'b', evidence: [{ turnId: 't9', quote: 'Building on what Priya said' }] },
        clarity: { value: null, basis: 'b', evidence: [] },
      },
      quotes: [{ turnId: 't21', quote: 'What if the homework is just reading', move: 'Asks what follows', why: 'w' }],
      strength: { text: 'Asks for evidence.', turnId: 't5', quote: 'How do you know' },
      nextStep: { text: 'Give your own reasons.', turnId: 't28', quote: 'so less weekend homework could help grades' },
    }],
  };
  const stream = (json, stop = 'end_turn') => sse([
    { type: 'message_start', message: { model: DEFAULT_MODEL } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(json).slice(0, 40) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(json).slice(40) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop } },
    { type: 'message_stop' },
  ]);
  const KEY = 'sk-ant-test-0000';

  test('transcript lines are numbered with name and time', () => {
    expect(transcriptLines(session).split('\n')[11]).toBe('[t12 | Maya | 01:05] What do you think Sam?');
  });

  test('request: headers, default model, structured output, key only in header', async () => {
    let seen;
    const logs = [];
    const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
    const fetch = async (url, init) => { seen = { url, init }; return new Response(stream(goodJson), { headers: { 'content-type': 'text/event-stream' } }); };
    const progress = [];
    const a = await analyzeWithClaude(session, KEY, { fetch, onProgress: p => progress.push(p.stage) });
    console.log = orig;
    const body = JSON.parse(seen.init.body);
    expect(seen.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen.init.headers['x-api-key']).toBe(KEY);
    expect(seen.init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.messages[0].content).toContain('[t12 | Maya | 01:05]');
    expect(body.system).toContain('6–8');
    expect(seen.init.body.includes(KEY)).toBe(false);
    expect(logs.join(' ').includes(KEY)).toBe(false);
    expect(progress).toContain('writing');

    // cleaned result in the ClaudeAnalysis shape
    expect(a.model).toBe(DEFAULT_MODEL);
    expect(a.summary).toContain('phone');
    expect(a.people[0].scores.questions.value).toBe(4);
    expect(a.people[0].scores.questions.label).toBe('Strong');
    expect(a.people[0].scores.reasoning.value).toBeNull();      // only evidence was made up
    expect(a.people[0].quotes.length).toBe(1);
    expect(a.people[0].strength.quote).toBe('How do you know');
    expect(a.topics[0].turnIds.length).toBe(17);
    expect(a.topics[1].keyQuote).toBeNull();
    expect(a.droppedQuotes).toBe(2);
  });

  test('refusal fallback mid-stream: keeps only the final model\'s text when the join is not JSON', async () => {
    const full = JSON.stringify(goodJson);
    const ev = [
      { type: 'message_start', message: { model: DEFAULT_MODEL } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: full.slice(0, 30) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: DEFAULT_MODEL }, to: { model: 'claude-opus-5' } } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: full } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    const fetch = async () => new Response(sse(ev), { headers: { 'content-type': 'text/event-stream' } });
    const stages = [];
    const a = await analyzeWithClaude(session, KEY, { fetch, onProgress: p => stages.push(p.stage) });
    expect(stages).toContain('fallback');
    expect(a.model).toBe('claude-opus-5');
    expect(a.people[0].scores.questions.value).toBe(4);
    // a fallback that continues the partial (join parses) also works
    const ev2 = ev.map(e => (e.index === 2 && e.delta ? { ...e, delta: { ...e.delta, text: full.slice(30) } } : e));
    const fetch2 = async () => new Response(sse(ev2), { headers: { 'content-type': 'text/event-stream' } });
    expect((await analyzeWithClaude(session, KEY, { fetch: fetch2 })).people[0]).toBeTruthy();
  });

  test('model override is sent', async () => {
    let body;
    const fetch = async (u, init) => { body = JSON.parse(init.body); return new Response(stream(goodJson), { headers: { 'content-type': 'text/event-stream' } }); };
    await analyzeWithClaude(session, KEY, { fetch, model: 'claude-sonnet-5-5' });
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(buildRequest(session, { model: 'claude-haiku-4-5' }).body.fallbacks).toBeUndefined();
  });

  test('clear errors: bad key, 429, overloaded, refusal, no key', async () => {
    const errRes = (status, type, headers = {}) => async () =>
      new Response(JSON.stringify({ type: 'error', error: { type, message: 'm' } }), { status, headers });
    const run = (fetch, extra = {}) => analyzeWithClaude(session, KEY, { fetch, maxRetries: 0, ...extra }).then(() => null, e => e);
    const bad = await run(errRes(401, 'authentication_error'));
    expect(bad.message).toContain('API key was rejected');
    expect(bad.message.includes(KEY)).toBe(false);
    const rl = await run(errRes(429, 'rate_limit_error', { 'retry-after': '7' }));
    expect(rl.message).toContain('Rate limit');
    expect(rl.message).toContain('7 s');
    expect(rl.retryable).toBe(true);
    expect((await run(errRes(529, 'overloaded_error'))).message).toContain('overloaded');
    const midStream = async () => new Response(sse([{ type: 'message_start', message: {} }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]), { headers: { 'content-type': 'text/event-stream' } });
    expect((await run(midStream)).message).toContain('overloaded');
    const refuse = async () => new Response(stream({}, 'refusal'), { headers: { 'content-type': 'text/event-stream' } });
    expect((await run(refuse)).type).toBe('refusal');
    expect((await analyzeWithClaude(session, '', {}).catch(e => e)).message).toContain('API key');
    // retries a 529 then succeeds
    let n = 0;
    const flaky = async () => (++n === 1 ? errRes(529, 'overloaded_error')() : new Response(stream(goodJson), { headers: { 'content-type': 'text/event-stream' } }));
    const ok = await analyzeWithClaude(session, KEY, { fetch: flaky, maxRetries: 1, retryDelayMs: 1 });
    expect(n).toBe(2);
    expect(ok.people[0]).toBeTruthy();
  });
});
