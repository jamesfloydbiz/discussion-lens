// Per-turn tagging by wording rules. Built for raw speech-to-text: Chrome's Web Speech
// often has no punctuation, so questions are found from how a sentence starts as well as "?".
// Categories: Paul & Elder Socratic question types, Graesser & Person deep vs. shallow,
// Toulmin / Kuhn reasoning moves, Accountable Talk + Demszky et al. (2021) uptake.

export const DEEP_TYPES = ['clarification', 'evidence', 'assumption', 'viewpoint', 'implication', 'causal'];

export const STOPWORDS = new Set(`a about above after again against all also am an and any are aren't as at be because been
before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during
each else even ever every few for from further get gets getting go goes going gonna got had hadn't has hasn't have haven't
having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it
it's its itself just kind know let's like lot maybe me mean might more most much must my myself no nor not now of off oh ok
okay on once one only or other ought our ours ourselves out over own pretty probably put really right said same say says see
she she'd she'll she's should shouldn't so some something sort still such sure than that that's the their theirs them
themselves then there there's these they they'd they'll they're they've thing things think this those though through to
too um uh under until up us very wanna was wasn't way we we'd we'll we're we've well were weren't what what's when when's
where where's whether which while who who's whom why why's will with won't would wouldn't yeah yes yet you you'd you'll
you're you've your yours yourself yourselves actually basically gonna guess kinda stuff thats dont im its youre theyre
cant wont didnt doesnt isnt arent wasnt hes shes were whats lets cause also anyway anything everything nothing someone
everyone anyone people need want wanted make made take took give gave tell told come came look looked way ways thing`.split(/\s+/));

// --- text helpers ---

export function norm(s) {
  return s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-');
}

export function wordCount(s) { return (s.match(/[A-Za-z0-9’']+/g) || []).length; }

// Content words, crudely stemmed, for overlap and topics.
export function contentWords(s) {
  return (norm(s).match(/[a-z][a-z']+/g) || [])
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .map(stem);
}

export function stem(w) {
  w = w.replace(/'s$/, '');
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es') && /(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

// Fillers that never count as reasoning: "so", "like", "um", "you know", "I mean"…
// Question detection also drops a leading "and / but / then" ("but why…"); reasoning keeps them ("but what about").
const LEAD_FILLER = /^(?:(?:um+|uh+|er+|hmm+|so|like|well|okay|ok|oh|yeah|yes|right|alright|i guess)\b\s*)+/;
const LEAD_JOIN = /^(?:(?:and|but|then|wait|so|um+|uh+|like|okay|ok|well|yeah)\b\s*)+/;

export function stripFillers(s, joins = false) {
  const t = norm(s)
    .replace(/(?<!\b(?:do|did|does|don't|didn't|would|could|can|how|what|if|to|whether|that)\s+)\byou know\b,?/g, ' ')
    .replace(/(?<!\b(?:what|do|did|that|if)\s+)\bi mean\b,?/g, ' ')
    .replace(/[^a-z0-9'?\s]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(LEAD_FILLER, '').trim();
  return joins ? t.replace(LEAD_JOIN, '').trim() : t;
}

// Mid-run question openers used to split unpunctuated speech ("i think it's the sun why do you think that").
const OPENERS = String.raw`(?:but what about|why|how come|how do|how does|how did|how would|how could|how can|what if|what do you|what does|what did|what would|what's your|whats your|do you think|does anyone|did anyone|i wonder|i'm wondering|can you (?:explain|give|say)|could you (?:explain|give|say))\b`;
const NOT_AFTER = String.raw`(?<!\b(?:that's|thats|that is|is|was|which is|know|knows|knew|see|wonder|explain|understand|remember|about|show|shows|tell|sure|matter|out|but|and|why|how|ask|asks|asking|asked|wondering|wondered)\s+)`;
const MID_SPLIT = new RegExp(`\\s+${NOT_AFTER}(?=${OPENERS})`, 'gi');

// Sentences as exact substrings of `text`: [{ text, start, end }].
export function splitSentences(text) {
  const out = [];
  const push = (a, b) => {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a && /[A-Za-z0-9]/.test(text.slice(a, b))) out.push({ text: text.slice(a, b), start: a, end: b });
  };
  const re = /[.!?]+["')\]]*(?=\s|$)/g;
  let last = 0, m;
  const chunks = [];
  while ((m = re.exec(text))) { chunks.push([last, m.index + m[0].length]); last = m.index + m[0].length; }
  if (last < text.length) chunks.push([last, text.length]);
  for (const [a, b] of chunks) {
    const piece = text.slice(a, b);
    let prev = 0;
    // Only unpunctuated runs (Web Speech) are split at question openers; punctuated text keeps its clauses.
    const runs = /[.!?]["')\]]*$/.test(piece.trim()) ? [] : piece.matchAll(MID_SPLIT);
    for (const sm of runs) {
      if (wordCount(piece.slice(prev, sm.index)) >= 2) { push(a + prev, a + sm.index); prev = sm.index; }
    }
    push(a + prev, b);
  }
  return out;
}

// --- questions ---

const WH = /^(?:what|why|how|who|where|when|which|whose|whom)(?:'s|s)?\b/;
const SUBJ = /^(?:i|we|he|she|they|it|you|that|this|there|these|those|people)\b/;
const AUX = /^(?:do|does|did|is|are|was|were|am|can|could|would|will|should|shall|have|has|had|may|might|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|couldn't|wouldn't|won't|shouldn't|haven't|hasn't|isnt|arent|wasnt|werent|dont|doesnt|didnt|cant|couldnt|wouldnt|wont|shouldnt|havent|hasnt)\b/;
const AUX_SUBJ = /^(?:i|you|we|he|she|they|it|that|this|there|the|a|an|anyone|anybody|everyone|everybody|someone|somebody|people|any|all|your|his|her|their|our|my|these|those|y'all)\b/;
const Q_PHRASE = /^(?:you (?:guys )?think (?!about)|what if|do you think|i wonder|i'm wondering|im wondering|how come|does anyone|anyone|how about|what about)\b/;
const TAG_Q = /(?:,\s*right|don't you think|isn't it|aren't they|wasn't it)\s*\??$/;
const WH_STATEMENT = /^(?:which (?:is|means|shows)|what's (?:interesting|cool|weird|funny|crazy|important|strange|great|hard|good|bad|sad|nice|wild|annoying)|how much i)\b/;

export function isQuestion(sentence) {
  if (/\?\s*["')\]]*$/.test(sentence)) return true;
  const s = stripFillers(sentence, true);
  if (!s) return false;
  if (Q_PHRASE.test(s)) return true;
  if (WH.test(s)) {
    if (WH_STATEMENT.test(s)) return false;
    const rest = s.replace(WH, '').trim();
    // "what I think is…", "when we went…", "how it works is…" are statements.
    if (SUBJ.test(rest)) return /^(?:you|it|that)\s+(?:mean|think|say)\s*\??$/.test(rest);
    return true;
  }
  if (AUX.test(s)) return AUX_SUBJ.test(s.replace(AUX, '').trim());
  return TAG_Q.test(norm(sentence).trim()) && wordCount(s) > 3;
}

const TYPE_RULES = [
  ['yesno', /^how about\b/],
  ['clarification', /\bwhat (?:do|did) you mean\b|\bwhat does .{1,40}\bmean\b|\b(?:can|could) you (?:explain|clarify|say more|elaborate|give (?:me |us )?an example)|\bsay more\b|\bwhat are you saying\b|\bare you saying\b|\bdo you mean\b|\bwhat's an example\b|\bwhat is an example\b|\bwhat do you mean by\b/],
  ['evidence', /\bhow (?:do|can|would|could) (?:you|we|they) (?:know|tell|be sure|prove)\b|\b(?:what|where)(?:'s| is| are)? (?:your|the) (?:evidence|proof|source)\b|\bwhat (?:evidence|proof)\b|\bany (?:evidence|proof)\b|\bis there (?:any )?(?:evidence|proof)\b|\bwhy (?:do|would|did) you (?:think|believe|say|feel)\b|\bwhat makes you (?:think|say|believe)\b|\bwhere (?:in the (?:text|book|story|article|poem|passage)|does it say)\b|\bwhere did you (?:get|read|see|hear)\b|\bwhat(?:'s| is| are) (?:your|the) reasons?\b|\bhow sure are you\b|\bwhy is that\b|\bwhat's that based on\b|\bwhat is that based on\b/],
  ['assumption', /\bassum|\btaking for granted\b|\b(?:is|does) (?:that|it|this) always\b|\bis (?:that|it) (?:really|necessarily) (?:true|the case)\b|\bwhat if (?:that|it|this)(?:'s| is) (?:not|wrong)\b|\bwhy (?:should|would) we (?:accept|believe|trust)\b|\bdo we know (?:that )?for sure\b|\bare we sure\b|\bisn't that (?:just )?(?:an opinion|a guess)\b/],
  ['implication', /^what if\b|\bwhat would happen\b|\bwhat happens (?:if|when)\b|\bthen what\b|\bwhat (?:does|would|will) (?:that|this) mean\b|\bso what\b|\bwhat (?:are|would be) the (?:consequences|effects|implications|results)\b|\bwhat (?:would|could|might) (?:that|this) lead to\b|\bhow (?:would|does|will|might|could) (?:that|this|it) (?:affect|change|impact)\b|\b(?:would|does) (?:that|this) mean\b|\bwhat (?:could|should|would|can) (?:we|you|they|people) do\b|\bhow (?:could|would|might|can|should) (?:we|you|they|people)\b|\bwhat would (?:we|you|they) have to\b/],
  ['viewpoint', /^you (?:guys )?think\b|\b(?:is|was) (?:the|this) (?:story|author|text|book|poem|writer|narrator) (?:saying|trying|showing|suggesting|telling)\b|\bhow (?:would|might|does|do) .{1,30}\b(?:see|view|feel about|look at)\b|\bdo you (?:think|agree|disagree|feel|believe)\b|\b(?:does|do|did) (?:anyone|anybody|everyone|everybody|you all|y'all|you guys) (?:think|agree|disagree|else|feel)\b|\bwhat (?:do|does|did) (?:you|we|others|people|everyone|everybody|anyone|y'all|you guys|you all) (?:think|feel)\b|\bhow do you feel\b|\bfrom (?:his|her|their|the other|another|a different) (?:side|perspective|point of view)\b|\bwhat about\b|\banother (?:way|view|side|perspective)\b|\bwhat(?:'s| is) (?:your|the other) (?:opinion|view|take|perspective|side)\b|\bwhat would .{1,30} (?:say|think)\b|\bwho (?:agrees|disagrees)\b|\banyone (?:agree|disagree|else)\b|\bwould you (?:agree|say|rather)\b|\bwhich (?:do|would) you (?:prefer|choose|pick)\b|^(?:should|shouldn't) (?!i\b)\w+|\bis (?:it|that) (?:fair|right|wrong|good|bad|okay|ok)\b/],
  ['causal', /\bwhy\b|\bhow come\b|\bwhat (?:causes|caused|makes|made|led to|leads to)\b|\bwhat(?:'s| is) the (?:cause|reason|difference|connection|relationship)\b|\bhow (?:does|do|did|can|could|is|are) .{0,40}\b(?:work|happen|cause|form|change|grow|connected|related|different|similar|alike)\b/],
];

// Paul & Elder type for one question sentence; deep = Graesser & Person deep / Nystrand authentic.
export function classifyQuestion(sentence) {
  const s = stripFillers(sentence, true);
  const wonder = s.match(/^(?:i wonder|i'm wondering|im wondering)\s*(?:if|whether)?\s*(.*)$/);
  if (wonder) {
    const inner = classifyQuestion(wonder[1] + '?');
    return inner.deep ? inner : { type: 'viewpoint', deep: true };
  }
  for (const [type, re] of TYPE_RULES) if (re.test(s)) return { type, deep: DEEP_TYPES.includes(type) };
  if (/^how\b/.test(s) && !/^how (?:many|much|long|old|far|often|big|tall)\b/.test(s)) return { type: 'causal', deep: true };
  if (WH.test(s)) return { type: 'factual', deep: false };
  return { type: 'yesno', deep: false };
}

// --- reasoning (Toulmin grounds / warrants / qualifiers; Kuhn counterargument & rebuttal) ---

// Mid-sentence "so" + a new clause ("it was cold so the pond froze"); not "so angry", "so much", or a leading "so".
const SO_INFER = /\b(?!so\b)[a-z']+\s+so\s+(?:i|we|you|he|she|they|it|it's|that|that's|this|there|the|a|an|people|kids|everyone|nobody|maybe|then|less|more|our|their|his|her|my|your|if|now)\b/;

export const REASON_RULES = [
  ['reason', /\bbecause\b|\bcuz\b|(?<!\b(?:the|a|main|root|what|good|no)\s)\b'?cause\b(?!\s+(?:of|and)\b)|\bsince (?:it|the|they|we|he|she|there|you|i|that|this|a|people)\b|\bthe reason (?:is|why|being|was)\b|\bthat'?s why\b|\bthat is why\b|\bwhich is why\b|\bdue to\b|\bmy reason\b/],
  ['evidence', /\bfor (?:example|instance)\b|\blike (?:when|the time)\b|\bsuch as\b|^in the (?:text|book|story|article|passage|poem|video|chart|graph|data|study|reading|chapter)\b|\bin the (?:text|book|story|article|passage|poem|chapter|reading),? (?:it|he|she|they|the author|the narrator|when|where|we)\b|\b(?:it|the (?:text|book|author|article|story|poem|passage|narrator|writer)) (?:says|said|shows|showed|describes|tells us)\b|\bon page\b|\bpage \d+|\baccording to\b|\b(?:studies|research|data|statistics|scientists|experts|surveys?) (?:show|shows|say|says|found|find|suggest)\b|\b\d+ ?(?:percent|%)|\bi (?:read|saw|heard|noticed) (?:that|in|on|about|a)\b|\bwhen i (?:was|went|did|tried)\b|\bin my experience\b|\bthe author (?:says|writes|wrote|said)\b|\bline \d+|\bthe evidence\b|\bfor one thing\b|\bproof is\b/],
  ['inference', /\btherefore\b|\bthus\b|\bhence\b|\b(?:that|which|this|it) means\b|\bmeaning that\b|\bif\b.{1,60}\bthen\b|\bif\b.{3,80}\b(?:would|wouldn't|will|won't)\b|\bmust (?:be|have|mean)\b|\b(?:that|this|which|it) (?:shows|proves|suggests)\b|\b(?:shows|proves|suggests) that\b|\bconclude\b|\bas a result\b|\bso then\b/],
  ['qualifier', /\bmaybe\b|\bprobably\b|\bperhaps\b|\bpossibly\b|\bmight\b|\bit depends\b|\bdepends on\b|\bnot always\b|\busually\b|\bsometimes\b|\bin some cases\b|\bmost of the time\b|\bunless\b|\bi'?m not (?:totally |completely |a hundred percent )?sure\b|\bnot necessarily\b|\bto some extent\b|\bpartly\b|\bgenerally\b|\bmostly\b|\bcould be\b|\bkind of depends\b/],
  ['counter', /\bbut what about\b|\bi disagree\b|\bi don'?t agree\b|\bon the other hand\b|\bhowever\b|\bthe problem (?:is|with)\b|\bthat'?s not (?:true|right|fair|always|how)\b|\bi don'?t think (?:that'?s|so|it'?s|it|they|he|she|we|you)\b|\bbut (?:if|then|isn'?t|doesn'?t|wouldn'?t|couldn'?t|what if|actually|really|that doesn'?t)\b|\bcounter ?(?:point|argument)\b|\bthe other side\b|\bnot necessarily\b|\bthat doesn'?t (?:mean|prove|work)\b|\bwhat if (?:that|it|this)(?:'s| is) (?:not|wrong)\b/],
  ['concession', /\bi see (?:your|what you|the) (?:point|mean)\b|\b(?:that'?s|that is|you'?re|it'?s) (?:true|right|fair|a good point)\b.{0,40}\bbut\b|\bfair point\b|\bgood point\b.{0,30}\bbut\b|\bi agree\b.{0,50}\bbut\b|\beven though\b|\balthough\b|\bi get (?:that|it|what you)\b|\bgranted\b|\badmittedly\b|\bi (?:can )?see why\b|\byou have a point\b|\bto be fair\b|\bi'?ll give you that\b/],
];

const ORDER = REASON_RULES.map(r => r[0]);

// Reasoning tags for one sentence. Question sentences only carry counter/concession moves.
export function reasoningTags(sentence, question = isQuestion(sentence)) {
  const s = stripFillers(sentence);
  const tags = new Set();
  for (const [tag, re] of REASON_RULES) {
    if (question && tag !== 'counter' && tag !== 'concession') continue;
    if (re.test(s)) tags.add(tag);
  }
  if (!question && SO_INFER.test(s)) tags.add('inference');
  return ORDER.filter(t => tags.has(t));
}

// A claim: a statement (not a question) of 5+ words that takes a stance, not classroom procedure.
const PROCEDURAL = /^(?:let'?s|let us|before we|for tomorrow|please|i want to (?:start|make sure|move|hear)|great discussion|last quick thoughts|you all read|okay let'?s|ok let'?s|so let'?s|that's fine)\b/;
const STANCE = /\b(?:is|are|was|were|isn't|aren't|wasn't|it's|that's|she's|he's|they're|think|thinks|believe|feel|feels|seems?|shows?|means?|should|would|could|can|must|has|have|had|did|does|makes?|wants?|wanted)\b/;

export function isClaim(sentence, question = isQuestion(sentence)) {
  const s = stripFillers(sentence, true);
  return !question && wordCount(s) >= 5 && !PROCEDURAL.test(s) && STANCE.test(s);
}

// --- building on others (Accountable Talk markers + uptake) ---

const BUILD = /\bbuild(?:ing)? (?:on|off)\b|\badd(?:ing)? (?:on )?to (?:what|that|his|her|their|your)\b|\bto add on\b|\bpiggy ?back|\bi (?:agree|disagree) with\b|\b(?:like|as) (?:\w+ )?(?:said|mentioned|was saying|pointed out)\b|\b(?:you|he|she|they) (?:said|mentioned)\b|\bwhat (?:you|he|she|they) (?:said|meant|mentioned)\b|\b(?:your|his|her|their) (?:point|idea)\b|\bgoing back to\b|\bback to what\b|\bto your point\b|\bi (?:totally |kind of |partly )?(?:agree|disagree)\b|\bi want to add\b|\bjust to add\b|\bjumping off\b|\bfollowing up on\b|\bi see your point\b|\bgood point\b|\bthat'?s a good point\b|\bthat'?s (?:true|right)\b/;

const GENERIC_NAME = /^(?:speaker|person|student|participant)\s*\d+$/i;

function firstName(name) {
  if (!name || GENERIC_NAME.test(name.trim())) return null;
  const f = norm(name).trim().split(/\s+/)[0].replace(/[^a-z']/g, '');
  return f.length >= 3 ? f : null;
}

// Shared content words with the previous other-speaker turn (approximate uptake, Demszky et al. 2021).
export function overlap(a, b) {
  const A = new Set(contentWords(a)), B = new Set(contentWords(b));
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n;
}

// Words in more than 30% of turns ("she", "story", "character") say nothing about uptake.
export function genericWords(turns) {
  const df = new Map();
  for (const t of turns) for (const w of new Set(contentWords(t.text))) df.set(w, (df.get(w) || 0) + 1);
  const cut = Math.max(2, 0.3 * turns.length);
  return new Set([...df].filter(([, n]) => n > cut).map(([w]) => w));
}

// Shared content words, ignoring generic ones.
export function sharedWords(a, b, generic = new Set()) {
  const B = new Set(contentWords(b));
  return [...new Set(contentWords(a))].filter(w => B.has(w) && !generic.has(w));
}

// Other speaker named in a sentence, not just addressed ("Leo, what…?" / "…, Leo?" are vocatives).
export function mentionedSpeaker(sentence, speakerId, speakers) {
  const s = norm(sentence).trim();
  for (const sp of speakers || []) {
    const f = firstName(sp.name);
    if (sp.id === speakerId || !f) continue;
    if (!new RegExp(`\\b${f}\\b`).test(s)) continue;
    const vocative = new RegExp(`^${f}\\s*,|,\\s*${f}\\s*[?.!]?$|^${f}\\s*[?.!]?$`).test(s);
    if (!vocative) return sp;
  }
  return null;
}

// Does this sentence explicitly link to someone else's idea?
export function isBuildSentence(sentence, speakerId, speakers) {
  return BUILD.test(stripFillers(sentence)) || !!mentionedSpeaker(sentence, speakerId, speakers);
}

// Explicit = a building marker or a named peer; uptake = that, or 2+ shared non-generic
// content words with the previous other-speaker turn (Demszky et al. 2021, approximated).
export function buildsOn(turn, prior, speakers, generic = new Set()) {
  let explicit = false, from = null;
  for (const sen of splitSentences(turn.text)) {
    if (BUILD.test(stripFillers(sen.text))) explicit = true;
    const sp = !from && mentionedSpeaker(sen.text, turn.speaker, speakers);
    if (sp) { explicit = true; from = [...prior].reverse().find(t => t.speaker === sp.id) || null; }
  }
  const prevOther = [...prior].reverse().find(t => t.speaker !== turn.speaker) || null;
  if (!from && prevOther && (explicit || sharedWords(turn.text, prevOther.text, generic).length >= 2)) from = prevOther;
  return { explicit, uptakeFrom: from ? from.id : null };
}

// --- per-turn tags (RulesAnalysis.turnTags) ---

export function tagTurn(turn, prior = [], speakers = [], generic = new Set()) {
  const questions = [], reasoning = new Set();
  for (const sen of splitSentences(turn.text)) {
    const q = isQuestion(sen.text);
    if (q) questions.push({ text: sen.text, ...classifyQuestion(sen.text) });
    for (const t of reasoningTags(sen.text, q)) reasoning.add(t);
  }
  return { questions, reasoning: ORDER.filter(t => reasoning.has(t)), buildsOn: buildsOn(turn, prior, speakers, generic) };
}

export function tagTurns(turns, speakers = []) {
  const out = {};
  const generic = genericWords(turns);
  turns.forEach((t, i) => { out[t.id] = tagTurn(t, turns.slice(Math.max(0, i - 6), i), speakers, generic); });
  return out;
}

// Does the turn end on a question? (used for quick-takeover detection)
export function endsWithQuestion(text) {
  const s = splitSentences(text);
  return s.length > 0 && isQuestion(s[s.length - 1].text);
}
