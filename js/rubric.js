// Rubric: four thinking dimensions, each with its research basis and four plain-language
// anchors per age band. Level 1 = just starting, 4 = strong for that age.

export const AGE_BANDS = [
  { key: 'k5', label: 'K–5' }, { key: '68', label: '6–8' },
  { key: '912', label: '9–12' }, { key: 'adult', label: 'Adult' },
];

export const LEVELS = ['Emerging', 'Developing', 'Proficient', 'Strong'];
export const NO_EVIDENCE = 'Not enough evidence';

export function levelLabel(value) {
  return value >= 1 && value <= 4 ? LEVELS[value - 1] : NO_EVIDENCE;
}

export const RUBRIC = [
  {
    key: 'questions',
    name: 'Question quality',
    basis: [
      'Paul, R. & Elder, L. (2006). The Thinker\'s Guide to the Art of Socratic Questioning.',
      'Graesser, A. C. & Person, N. K. (1994). Question asking during tutoring. American Educational Research Journal, 31(1).',
      'Nystrand, M. et al. (2003). Questions in time. Discourse Processes, 35(2).',
    ],
    anchors: {
      k5: ['Asks only yes/no or "what is" questions.', 'Asks a "why" or "how" question.',
        'Asks why or how, or asks a friend what they mean.', 'Asks several why/how/what-if questions that move the talk.'],
      '68': ['Questions check facts only.', 'At least one question asks why, how, or for an example.',
        'Asks for reasons, evidence, or what someone means.', 'Asks varied deep questions (evidence, what-if, other views) that open new thinking.'],
      '912': ['Questions recall facts or seek yes/no.', 'Some open questions, mostly about facts.',
        'Probes reasons, evidence, or assumptions.', 'Probes assumptions, implications, and other viewpoints; questions shape the discussion.'],
      adult: ['Closed or factual questions only.', 'Occasional open question.',
        'Regularly probes evidence, meaning, or causes.', 'Authentic, varied questions that test assumptions and implications.'],
    },
  },
  {
    key: 'reasoning',
    name: 'Reasoning',
    basis: [
      'Toulmin, S. (1958). The Uses of Argument: claim, grounds, warrant, qualifier, rebuttal.',
      'Kuhn, D. (1991). The Skills of Argument; Kuhn & Udell (2003), Child Development, 74(5).',
    ],
    anchors: {
      k5: ['Says what they think, no reason.', 'Gives a reason ("because…").',
        'Gives reasons and an example.', 'Gives reasons, an example, and answers "but what about…".'],
      '68': ['Claims without reasons.', 'Backs a claim with a reason.',
        'Uses reasons and evidence or examples; notes when it depends.', 'Also deals with the other side: counterargument or concession.'],
      '912': ['Unsupported claims.', 'Claims with some reasons.',
        'Grounds claims in evidence and explains the link; qualifies.', 'Builds a full argument and answers counterarguments.'],
      adult: ['Assertions only.', 'Some reasons given.',
        'Claims, grounds, and warrants; calibrated certainty.', 'Weighs counterarguments and rebuts or concedes them.'],
    },
  },
  {
    key: 'building',
    name: 'Building on others',
    basis: [
      'Michaels, S., O\'Connor, C. & Resnick, L. (2008). Accountable Talk. Studies in Philosophy and Education, 27.',
      'Demszky, D. et al. (2021). Measuring conversational uptake. ACL 2021.',
      'Mercer, N. (2000). Words and Minds: exploratory talk.',
    ],
    anchors: {
      k5: ['Says own idea without linking.', 'Sometimes repeats a friend\'s words.',
        'Says "I agree/disagree with ___ because".', 'Often adds to friends\' ideas and says why.'],
      '68': ['Turns don\'t connect to others.', 'Picks up others\' words now and then.',
        'Names or links to others\' ideas.', 'Regularly builds on, extends, or challenges others with reasons.'],
      '912': ['Talks past others.', 'Some uptake of others\' ideas.',
        'Explicitly builds on or responds to peers.', 'Weaves peers\' ideas together and pushes them further.'],
      adult: ['Independent statements.', 'Occasional uptake.',
        'Frequent, explicit uptake.', 'Synthesizes and extends others\' contributions.'],
    },
  },
  {
    key: 'clarity',
    name: 'Clarity & precision',
    basis: [
      'Paul, R. & Elder, L. (2014). The Miniature Guide to Critical Thinking: intellectual standards (clarity, precision, relevance).',
    ],
    anchors: {
      k5: ['Hard to follow.', 'Mostly clear.', 'Clear and on topic.', 'Clear, specific, and on topic.'],
      '68': ['Vague or off topic.', 'Clear in parts.', 'Clear and relevant.', 'Clear, precise, and relevant.'],
      '912': ['Vague or off topic.', 'Mostly clear, some vague terms.', 'Clear, relevant, fairly precise.', 'Precise, well defined, relevant.'],
      adult: ['Unclear.', 'Partly clear.', 'Clear and relevant.', 'Precise, concise, relevant.'],
    },
  },
];

export function rubricFor(key) { return RUBRIC.find(r => r.key === key); }

// Anchor text for one dimension at one age band and level (1–4).
export function anchor(key, ageBand, value) {
  const r = rubricFor(key);
  return r && value ? (r.anchors[ageBand] || r.anchors.adult)[value - 1] : '';
}
