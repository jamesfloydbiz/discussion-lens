# Discussion Lens

Listens to a discussion on one laptop, works out who said what, and builds a dashboard for each person: talk share, quality quotes, topics, and 1–4 scores for questions, reasoning, building on others and clarity.

Free, with no server. Everything runs in the browser.

| Piece | How |
|---|---|
| Live transcript | Browser speech recognition (Web Speech API; Chrome/Edge). Chrome sends the audio to Google for this. |
| Who's talking | WeSpeaker voiceprints (`onnx-community/wespeaker-voxceleb-resnet34-LM`) via transformers.js 4.3.1, grouped in `js/clustering.js` |
| Uploaded recordings | Whisper (`whisper-base.en`) in the browser |
| Scores | Research-coded rules for everyone (`js/rules.js`); optional deep analysis with your own Claude key, kept only in your browser |
| Storage | IndexedDB on this laptop; JSON export and import |

## Run locally
```bash
bun install
```
```bash
bun run dev
```
Then open http://localhost:4317. To run the tests:
```bash
bun test
```

## Speaker accuracy (measured)
| Test | Speakers found | Correct |
|---|---|---|
| Podcast, 2 real voices, 10 min | 2 of 2 | 96.1% of speech time |
| 5 synthetic voices, 3.7 min (bun) | 5 of 5 | 88.6% of speech time, 97.7% of turn time |
| Same file, uploaded in the browser | 5 of 5 | 95.3% of turn time |

Not yet measured: a real classroom with 3+ voices, crosstalk and kids' voices. Entering the number of speakers helps. `tools/check-upload.js` scores any recording that has reference labels.

## Layout
- `docs/CONTRACTS.md`: data shapes shared by every module
- `js/live.js`, `js/upload.js`, `js/speakers.worker.js`, `js/transcribe.js`, `js/audio.js`, `js/turns.js`: audio to speaker-labelled turns
- `js/analyze.js` (`rules.js`, `metrics.js`, `topics.js`, `rubric.js`), `js/claude.js`, `js/quotes.js`: scoring; every quote is checked as verbatim
- `index.html` + `js/app.js` (record), `report.html` + `js/report.js` (dashboard), `js/store.js`
- `data/sample-session.json`: a scripted sample for the demo dashboard
- Each turn has `signals: {}`, reserved for a future video and body-language model.
