# Discussion Lens: shared contracts (PM-owned; ICs build to this, don't change it without asking the PM)

Static site, no build step, plain ES modules (`<script type="module">`), deployed to GitHub Pages.
Everything runs in the visitor's browser. Tests: `bun test tests/` (bun 1.3; test pure modules only).
CDN lib (pinned, also used in workers): `https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1`
Times are **seconds from session start** everywhere. Speaker ids are small integers (0, 1, 2…).

## Session (IndexedDB store `sessions`, also the JSON export)
```js
{
  id: 'lx3k9…', createdAt: ISO, title: 'Untitled discussion', ageBand: 'k5'|'68'|'912'|'adult',
  source: 'live'|'upload'|'sample', durationSec: number,
  speakers: [{ id: 0, name: 'Speaker 1', color: '#…' }],
  phrases: [{ id: 'p1', start, end, text, source: 'webspeech'|'whisper' }],   // raw ASR
  windows: [{ t, dur, speaker }],                 // one per voiced phrase piece (variable dur), labelled by labelPhrases
  turns:   [{ id: 't1', speaker, start, end, text, signals: {} }],  // signals reserved for a future video model
  analysis: { rules: RulesAnalysis, claude: ClaudeAnalysis | null }
}
```
Embeddings are stored apart (store `embeddings`, key = session id, `{dim, data: Float32Array}`), never exported.

## Score
```js
Score = { value: 1|2|3|4|null, label: 'Developing'|…, basis: 'one line: what this was judged on',
          evidence: [{ turnId, quote }] }      // quote = verbatim substring of that turn's text
```
`value: null` means "not enough evidence" (e.g. asked no questions). Dimension keys: `questions`, `reasoning`, `building`, `clarity`.

## RulesAnalysis — `js/analyze.js` → `analyzeRules(session)` (IC-Analysis)
```js
{
  metrics: { totalTalkSec, gini,
    perSpeaker: { [id]: { talkSec, share, turns, words, avgTurnSec, avgTurnWords,
                          questions, deepQuestions, quickTakeovers } },
    respondsTo: { [fromId]: { [toId]: count } } },        // toId spoke right after fromId
  turnTags: { [turnId]: { questions: [{ text, type, deep }],
              reasoning: ['reason'|'evidence'|'inference'|'qualifier'|'counter'|'concession'],
              buildsOn: { explicit: bool, uptakeFrom: turnId|null } } },
  people: { [id]: { scores: { questions: Score, reasoning: Score, building: Score, clarity: Score },  // clarity.value null in rules mode
                    quotes: [{ turnId, quote, move, why }] } },   // 2–3 best moments
  topics: [{ id, title, keywords: [], start, end, turnIds: [], drivers: [speakerId], keyQuote: { turnId, quote } }]
}
```
Question `type`: `clarification | evidence | assumption | viewpoint | implication | causal | factual | yesno` (deep = all but factual/yesno).

## ClaudeAnalysis — `js/claude.js` → `analyzeWithClaude(session, apiKey, { model, onProgress })` (IC-Analysis)
Same `people` and `topics` shapes as rules, plus per person `strength` and `nextStep` = `{ text, turnId, quote }`,
plus top-level `summary`, `model`, `createdAt`, `droppedQuotes` (count removed by the quote check).
All quotes pass `js/quotes.js` → `verifyQuote(quote, turnText)` / `cleanAnalysis(analysis, turns)`.
UI shows Claude results where present, rules otherwise.

## Rubric — `js/rubric.js` (IC-Analysis)
```js
export const AGE_BANDS = [{ key: 'k5', label: 'K–5' }, { key: '68', label: '6–8' }, { key: '912', label: '9–12' }, { key: 'adult', label: 'Adult' }];
export const RUBRIC = [{ key, name, basis: [citation strings], anchors: { k5: [a1,a2,a3,a4], '68': […], '912': […], adult: […] } }];
```

## Audio + speakers — IC-Audio
- `js/live.js` → `startLive({ expectedSpeakers, onPhrase, onStatus }) → { stop(): Promise<Capture> }`
  `onPhrase(phrase & { speaker })` gives a provisional speaker for the live view.
- `js/upload.js` → `processUpload(file, { expectedSpeakers, onProgress }) → Promise<Capture>`
- `Capture = { phrases, windows, embeddings: { dim, data }, durationSec }` — windows already relabelled by `regroup` from `js/clustering.js` (exists, PM-owned).
- `js/turns.js` → `buildTurns(phrases, windows) → turns`
- `js/speakers.worker.js` messages: in `{type:'init'}`, `{type:'embed', id, t, audio}`; out `{type:'progress', …}`, `{type:'ready'}`, `{type:'embedding', id, t, vector}`, `{type:'error', message}`.

## UI + storage — IC-UI
- `js/store.js`: `saveSession, getSession, listSessions, deleteSession, saveEmbeddings, getEmbeddings, exportSession(id) → JSON string, importSession(json)`.
- `index.html` (record / upload / past sessions), `report.html#<id>` (dashboard), `css/style.css`, `js/app.js`, `js/report.js`.
- `data/sample-session.json`: a **scripted** sample discussion (clearly labelled as scripted) so visitors see a dashboard without recording.
