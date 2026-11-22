const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { computeMetrics, computeScores, estimateContent } = require('../src/metrics');
const { parseAiJson } = require('../src/feedback');

const good = 'I am a final year computer engineering student and I built a campus attendance app using React Native and Firebase. It reduced manual roll calls by seventy percent and taught me teamwork and debugging under deadlines.';
const bad = 'um so basically I like uh I am a student and um like basically yeah';
const nonsense = 'Yesterday purple elephants danced across the quiet mountain while seven musicians repaired bicycles near a frozen river, and nobody remembered why the tall lighthouse kept whispering recipes about chocolate pancakes to wandering astronauts beside the enormous orange bridge that crossed several sleepy villages.';

test('good answer scores well, filler-heavy answer scores worse', () => {
  const m = computeMetrics(good, 18, 0), s = computeScores(m, good);
  const m2 = computeMetrics(bad, 20, 3), s2 = computeScores(m2, bad);
  assert(m.wpm >= 100 && m.wpm <= 170); assert.strictEqual(m.fillerCount, 0);
  assert(m2.fillerCount >= 6); assert(s2.overall < s.overall); assert(s.overall >= 70);
});
test('off-topic fluent answer can no longer score highly', () => {
  const s = computeScores(computeMetrics(nonsense, 17, 0), nonsense);
  assert(s.overall <= 55, `overall ${s.overall}`);
});
test('legitimate "like" and "actually" are not counted as fillers', () => {
  const t = 'I really like building apps and I like how it helped teachers. It is actually a useful project.';
  assert.strictEqual(computeMetrics(t, 10, 0).fillerCount, 0);
  assert(computeMetrics('So like we did it and, like, it worked basically fine', 10, 0).fillerCount >= 2);
});
test('wpm uses speaking time, not leading/trailing silence', () => {
  const words = Array(100).fill('word').join(' ');
  assert(computeMetrics(words, 60, 0, 40).wpm > computeMetrics(words, 60, 0).wpm);
});
test('typed answers do not get fake pace/fluency', () => {
  const s = computeScores(computeMetrics(good, 18, 0), good, { typed: true });
  assert.strictEqual(s.pace, null); assert.strictEqual(s.fluency, null);
});
test('AI content score is used when given and flagged as not estimated', () => {
  const s = computeScores(computeMetrics(good, 18, 0), good, { content: 90 });
  assert.strictEqual(s.estimated, false); assert.strictEqual(s.content, 90);
  assert(estimateContent(nonsense) < estimateContent(good));
});
test('parseAiJson handles fenced JSON, clamps scores, rejects bad shape', () => {
  const ok = '```json\n{"relevance":120,"structure_score":60,"specificity":40,"structure":"ok","tips":["a","b","c","d"],"sample":"s","followUp":"why?"}\n```';
  const r = parseAiJson(ok); assert.strictEqual(r.feedback.tips.length, 3); assert.strictEqual(r.content, Math.round(0.5 * 100 + 15 + 10));
  assert.throws(() => parseAiJson('{"structure":"x"}')); assert.throws(() => parseAiJson('no json here'));
});
test('mobile and backend copies of the scoring engine have not drifted', (t) => {
  const canon = path.join(__dirname, '../../shared/metrics.js'); const mob = path.join(__dirname, '../../mobile/src/lib/metrics.js');
  if (!fs.existsSync(canon) || !fs.existsSync(mob)) return t.skip('monorepo files not present');
  const a = fs.readFileSync(canon, 'utf8');
  assert.strictEqual(fs.readFileSync(mob, 'utf8'), a, 'run `npm run sync` at repo root');
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '../src/metrics.js'), 'utf8'), a, 'run `npm run sync` at repo root');
});
