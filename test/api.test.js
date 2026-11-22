const test = require('node:test'); const assert = require('node:assert');
for (const k of ['ANTHROPIC_API_KEY','GROQ_API_KEY','GEMINI_API_KEY','OPENROUTER_API_KEY','AI_PROVIDER']) delete process.env[k]; process.env.DEVICE_PER_MIN = '4'; process.env.APP_TOKEN = ''; process.env.DB_FILE = ':memory:';
const app = require('../server');
let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); });
const post = (p, body, id = 'device-abcdef01') => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': id }, body: JSON.stringify(body) });
const ok = { question: 'Tell me about yourself.', category: 'Self Introduction', transcript: 'I am a student and I built an app for my team that saved time.', durationSec: 12, pauses: 0 };

test('health is open', async () => { assert.strictEqual((await fetch(base + '/health')).status, 200); });
test('requires a device id', async () => { const r = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ok) }); assert.strictEqual(r.status, 400); });
test('rejects bad input', async () => {
  assert.strictEqual((await post('/api/analyze', { ...ok, transcript: '' }, 'device-bad00001')).status, 400);
  assert.strictEqual((await post('/api/analyze', { ...ok, durationSec: 999 }, 'device-bad00001')).status, 400);
});
test('analyze works without an AI key (rule feedback, no dev message)', async () => {
  const r = await post('/api/analyze', ok, 'device-ok000001'); assert.strictEqual(r.status, 200);
  const j = await r.json(); assert.strictEqual(j.feedback.source, 'rules'); assert.strictEqual(j.feedback.sample, ''); assert.strictEqual(j.scores.estimated, true);
});
test('per-device rate limit kicks in', async () => {
  let last; for (let i = 0; i < 6; i++) last = await post('/api/analyze', ok, 'device-spam0001'); assert.strictEqual(last.status, 429);
});
test('feedback validates rating', async () => {
  assert.strictEqual((await post('/api/feedback', { rating: 'meh' }, 'device-fb000001')).status, 400);
  assert.strictEqual((await post('/api/feedback', { rating: 'up', sessionId: '1' }, 'device-fb000001')).status, 200);
});
