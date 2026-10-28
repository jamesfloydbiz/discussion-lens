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
Speakers are found in two passes. Short 1.5 s voiceprints find where the speaker changes, and phrases are cut there. Then each piece gets one voiceprint from its own audio, and pieces are grouped by average-linkage clustering. Live recording keeps no full audio, so it averages the short voiceprints inside each phrase.

Share of speech time given the right speaker (best match of groups to people):

| Recording | Before (1.5 s windows) | Now |
|---|---|---|
| Classroom seminar, ~7 voices + narrator, 6 min, hand-labelled from the transcript (bun) | 67.0% | 98.3% upload · 94.4% live method |
| Same seminar, uploaded in the browser (WebGPU / `?lowmem`) | ~67% | 98.7% (10 groups) / 89.9% (8 groups) |
| 5 synthetic voices, 3.7 min, real Whisper phrases (bun) | 88.6% | 95.9% |
| Podcast, 2 real voices, 10 min (no labels kept; count check only) | 96.1% | 2 speakers found, 295 s vs 288 s |

Bigger voice models (WeSpeaker ResNet221/293, CAM++) did not beat ResNet34 on the seminar; the gain came from longer audio per voiceprint. Known weaknesses: similar voices can still share a group (Lily and Avery on the `?lowmem` run), the count can come out 1–2 high with spare groups holding a few seconds each, and labels are only as good as one hand-labelled clip. `tools/check-upload.js` scores any recording with reference labels; `spike/sem/eval.js` (local only) is the seminar comparison.

## Memory
An upload runs Whisper, then the voice model, never both at once. Safari reloads a tab that uses too much memory, so on Safari both models run on the CPU instead of WebGPU. Add `?lowmem` to the URL to do the same in any browser. Peak memory on the 6-min clip, measured in Chromium: 1.9 GB on WebGPU, 1.3 GB with `?lowmem` (it was 2.4 GB with both models loaded together).

## Layout
- `docs/CONTRACTS.md`: data shapes shared by every module
- `js/live.js`, `js/upload.js`, `js/speakers.worker.js`, `js/transcribe.js`, `js/audio.js`, `js/turns.js`: audio to speaker-labelled turns
- `js/analyze.js` (`rules.js`, `metrics.js`, `topics.js`, `rubric.js`), `js/claude.js`, `js/quotes.js`: scoring; every quote is checked as verbatim
- `index.html` + `js/app.js` (record), `report.html` + `js/report.js` (dashboard), `js/store.js`
- `data/sample-session.json`: a scripted sample for the demo dashboard
- Each turn has `signals: {}`, reserved for a future video and body-language model.
