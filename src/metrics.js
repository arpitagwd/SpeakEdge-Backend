// CANONICAL scoring logic (CommonJS). Edit ONLY this file, then run `npm run sync` at the repo root:
// it copies this file to backend/src/metrics.js and mobile/src/lib/metrics.js (a test fails if they drift).
// Transcript + timing based. NOT phoneme-level pronunciation analysis.
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const tokens = (t) => String(t).toLowerCase().match(/[a-z']+/g) || [];

// Words that are always hesitation sounds. Note: Android's recogniser often drops these from transcripts,
// so counts can be an under-estimate; long pauses act as the second signal.
const SOLO = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'hmm', 'ah']);
// "like" / "actually" / "you know" are only fillers outside their normal grammatical uses.
const LIKE_PREV = new Set(['i', 'we', 'you', 'they', 'would', 'do', "don't", 'did', "didn't", 'really', 'to', 'feel', 'looks', 'look', 'looked', 'sounds', 'something', 'anything', 'much', 'more', 'who', 'also', 'people', 'it', 'works', 'worked', 'felt', 'seems']);
const LIKE_NEXT = new Set(['a', 'an', 'the', 'to', 'this', 'that', 'how', 'my', 'your', 'our', 'their', 'it', 'working', 'building', 'solving', 'learning', 'when', 'what', 'being', 'doing', 'using', 'these', 'those', 'her', 'his', 'them', 'us', 'coding', 'playing', 'reading', 'teaching', 'helping', 'creating']);
const ACT_PREV = new Set(['what', 'is', 'was', 'were', 'are', 'not', 'it', 'that', 'really', 'and', 'but', 'had']);
const KNOW_PREV = new Set(['do', 'did', 'if', 'as', 'would', 'could', 'will', 'can', "don't", "didn't", 'to', 'you']);

function findFillers(words) {
  const out = {};
  const add = (k) => { out[k] = (out[k] || 0) + 1; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i], p = words[i - 1], n = words[i + 1];
    if (SOLO.has(w) || w === 'basically') add(w);
    else if (w === 'actually' && !ACT_PREV.has(p)) add(w);
    else if (w === 'like' && !LIKE_PREV.has(p) && !LIKE_NEXT.has(n)) add(w);
    else if (w === 'you' && n === 'know' && !KNOW_PREV.has(p)) { add('you know'); i++; }
    else if (w === 'i' && n === 'mean') { add('i mean'); i++; }
  }
  return out;
}

// speakingSec = time between first and last recognised speech (excludes leading/trailing silence); optional.
function computeMetrics(transcript, durationSec, pauses, speakingSec) {
  const words = tokens(transcript);
  const fillers = findFillers(words);
  const fillerCount = Object.values(fillers).reduce((a, b) => a + b, 0);
  const total = Math.max(Number(durationSec) || 1, 1);
  const basis = speakingSec >= 3 ? Math.min(speakingSec, total) : total;
  return { wordCount: words.length, wpm: Math.round(words.length / (basis / 60)), fillerCount, fillers, pauses: pauses || 0, durationSec: Math.round(total) };
}

// Offline estimate of answer quality (used when the AI coach is unavailable). Rewards first-person
// ownership, examples, outcomes and numbers; an off-topic word salad scores low (about 25).
function estimateContent(transcript) {
  const t = String(transcript).toLowerCase();
  const words = tokens(t);
  if (words.length < 5) return 10;
  const first = ((t.match(/\b(i|my|me|i'm|i've|i'd)\b/g) || []).length) / words.length;
  const cues = (t.match(/\b(for example|for instance|when i|i built|i made|i worked|i developed|i led|i created|project|internship|team|result|resulted|learned|achieved|improved|reduced|increased|because|so that|goal|skills?)/g) || []).length;
  const nums = (t.match(/\b(\d+|percent|hundred|thousand|lakh)/g) || []).length;
  return clamp(Math.min(85, 25 + Math.min(20, first * 200) + Math.min(30, cues * 8) + Math.min(10, nums * 5)));
}

// content: 0-100 from the AI coach (relevance/structure/specificity) or null to estimate offline.
// typed: pace and fluency are not measurable for typed answers, so they are null and excluded.
function computeScores(m, transcript, opts) {
  const { typed = false, content = null } = opts || {};
  const words = tokens(transcript);
  const diversity = words.length ? new Set(words).size / words.length : 0;
  const detail = clamp(0.6 * Math.min(100, (m.wordCount / 80) * 100) + 0.4 * Math.min(100, diversity * 130));
  const estimated = content == null;
  const c = clamp(estimated ? estimateContent(transcript) : content);
  if (typed) return { overall: clamp(Math.min(0.7 * c + 0.3 * detail, c + 25)), content: c, detail, pace: null, fluency: null, estimated };
  const pace = clamp(m.wpm < 110 ? 100 - (110 - m.wpm) * 1.2 : m.wpm > 160 ? 100 - (m.wpm - 160) * 1.2 : 100);
  const per100 = m.wordCount ? (m.fillerCount / m.wordCount) * 100 : 0;
  const fluency = clamp(100 - per100 * 8 - m.pauses * 6);
  const raw = 0.35 * c + 0.15 * detail + 0.2 * pace + 0.3 * fluency;
  // Delivery can never rescue an irrelevant answer: overall is capped just above the content score.
  return { overall: clamp(Math.min(raw, c + 25)), content: c, detail, pace, fluency, estimated };
}

function ruleFeedback(m, source, typed) {
  const tips = [];
  if (m.wordCount < 50) tips.push('Your answer was short. Aim for 80-150 words: point, example, result.');
  if (!typed) {
    if (m.wpm > 160) tips.push(`You spoke fast (${m.wpm} wpm). Slow down to about 120-150 wpm and breathe between ideas.`);
    if (m.wpm < 110 && m.wordCount >= 20) tips.push(`Your pace was slow (${m.wpm} wpm). Practise until it flows near 120-150 wpm.`);
    if (m.pauses >= 2) tips.push('Several long pauses. Prepare a 3-point outline so you never lose your place.');
  }
  if (m.fillerCount >= 3) tips.push(`You used ${m.fillerCount} filler words. Replace them with a silent one-second pause.`);
  if (!tips.length) tips.push('Good delivery. Add a specific number or example to make the answer memorable.');
  return { structure: 'Use a clear structure: one-line answer, one supporting example, one-line close.', tips: tips.slice(0, 3), sample: '', followUp: '', source: source || 'rules' };
}

module.exports = { computeMetrics, computeScores, estimateContent, ruleFeedback, findFillers };
