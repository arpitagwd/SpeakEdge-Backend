const test = require('node:test'); const assert = require('node:assert');
const { aiConfig, aiFeedback, parseAiJson } = require('../src/feedback');
const KEYS = ['ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'AI_PROVIDER', 'AI_MODEL'];
const clear = () => KEYS.forEach((k) => delete process.env[k]);
const good = JSON.stringify({ relevance: 80, structure_score: 70, specificity: 60, structure: 'ok', tips: ['a', 'b'], sample: 's', followUp: 'why?' });
const input = { question: 'Q', category: 'HR Basics', transcript: 'I built an app', metrics: { wpm: 120, fillerCount: 0 }, typed: false };
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; clear(); });

test('no key means no AI; a free key is auto-detected', () => {
  clear(); assert.strictEqual(aiConfig(), null);
  process.env.GROQ_API_KEY = 'k'; assert.strictEqual(aiConfig().name, 'groq');
  clear(); process.env.GEMINI_API_KEY = 'k'; assert.strictEqual(aiConfig().name, 'gemini');
  clear(); process.env.AI_PROVIDER = 'ollama'; assert.strictEqual(aiConfig().name, 'ollama'); // needs no key
  clear(); process.env.GROQ_API_KEY = 'k'; process.env.AI_MODEL = 'my-model'; assert.strictEqual(aiConfig().model, 'my-model');
});
test('OpenAI-compatible call (Groq/Gemini/Ollama) parses the reply', async () => {
  process.env.GROQ_API_KEY = 'k'; let seen;
  global.fetch = async (url, o) => { seen = { url, body: JSON.parse(o.body), auth: o.headers.authorization }; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '<think>hmm</think>' + good } }] }) }; };
  const r = await aiFeedback(input);
  assert.match(seen.url, /api\.groq\.com.*\/chat\/completions$/); assert.strictEqual(seen.auth, 'Bearer k'); assert.strictEqual(seen.body.response_format.type, 'json_object');
  assert.strictEqual(r.feedback.source, 'ai'); assert.strictEqual(r.content, Math.round(0.5 * 80 + 17.5 + 15));
});
test('a 400 (unsupported option) is retried without optional fields', async () => {
  process.env.GEMINI_API_KEY = 'k'; const bodies = [];
  global.fetch = async (_u, o) => { bodies.push(JSON.parse(o.body)); return bodies.length === 1 ? { ok: false, status: 400, text: async () => 'bad' } : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: good } }] }) }; };
  await aiFeedback(input); assert.strictEqual(bodies.length, 2); assert(!('response_format' in bodies[1])); assert(!('reasoning_effort' in bodies[1]));
});
test('a rate limit (429) triggers a cooldown so later calls fail instantly', async () => {
  process.env.GROQ_API_KEY = 'k'; let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 429, headers: { get: () => '30' }, text: async () => '' }; };
  await assert.rejects(aiFeedback(input), /rate limit/); await assert.rejects(aiFeedback(input), /cooling down/); assert.strictEqual(calls, 1);
});
test('parseAiJson strips <think> blocks', () => { assert.strictEqual(parseAiJson('<think>x {y}</think>' + good).feedback.tips.length, 2); });
