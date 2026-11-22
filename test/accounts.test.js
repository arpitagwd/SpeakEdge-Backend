const test = require('node:test'); const assert = require('node:assert');
process.env.DB_FILE = ':memory:'; process.env.JWT_SECRET = 'test-secret'; for (const k of ['ANTHROPIC_API_KEY','GROQ_API_KEY','GEMINI_API_KEY','OPENROUTER_API_KEY','AI_PROVIDER']) delete process.env[k];
const app = require('../server');
let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); });
const call = (method, p, body, token, id = 'device-acct0001') => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-device-id': id, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const sess = (id, overall = 70) => ({ id, date: new Date().toISOString(), questionId: 'si1', question: 'Q', category: 'HR Basics', transcript: 't', typed: false, metrics: {}, scores: { overall }, feedback: {} });
const A = { name: 'Asha', email: 'Asha@Example.com', password: 'longenough1', goal: 'placements' };

test('register, duplicate, validation', async () => {
  const r = await call('POST', '/api/auth/register', A); assert.strictEqual(r.status, 201);
  const j = await r.json(); assert(j.token); assert.strictEqual(j.user.email, 'asha@example.com'); assert(!('passHash' in j.user));
  assert.strictEqual((await call('POST', '/api/auth/register', { ...A, email: 'ASHA@example.com' })).status, 409);
  assert.strictEqual((await call('POST', '/api/auth/register', { ...A, email: 'bad' })).status, 400);
  assert.strictEqual((await call('POST', '/api/auth/register', { ...A, email: 'b@example.com', password: 'short' })).status, 400);
});
test('login works, wrong password fails, repeated failures lock out', async () => {
  assert.strictEqual((await call('POST', '/api/auth/login', { email: 'asha@example.com', password: 'longenough1' })).status, 200);
  assert.strictEqual((await call('POST', '/api/auth/login', { email: 'asha@example.com', password: 'nope-nope' })).status, 401);
  let last; for (let i = 0; i < 9; i++) last = await call('POST', '/api/auth/login', { email: 'lock@example.com', password: 'x' }, null, `device-lock${i}0000`);
  assert.strictEqual(last.status, 429);
});
test('sessions need auth, sync round-trips, upserts, isolates users', async () => {
  assert.strictEqual((await call('GET', '/api/sessions')).status, 401);
  const a = (await (await call('POST', '/api/auth/login', { email: 'asha@example.com', password: 'longenough1' })).json()).token;
  assert.strictEqual((await call('POST', '/api/sessions/bulk', { sessions: [sess('s1', 60), sess('s2')] }, a)).status, 200);
  await call('POST', '/api/sessions/bulk', { sessions: [sess('s1', 95)] }, a); // upsert, no duplicate
  const list = (await (await call('GET', '/api/sessions', null, a)).json()).sessions;
  assert.strictEqual(list.length, 2); assert.strictEqual(list.find((x) => x.id === 's1').scores.overall, 95);
  const b = (await (await call('POST', '/api/auth/register', { name: 'Ben', email: 'ben@example.com', password: 'longenough2' })).json()).token;
  assert.strictEqual((await (await call('GET', '/api/sessions', null, b)).json()).sessions.length, 0);
  assert.strictEqual((await call('POST', '/api/sessions/bulk', { sessions: [{ id: 'x' }] }, a)).status, 400);
});
test('bad token rejected; deleting the account removes the data', async () => {
  assert.strictEqual((await call('GET', '/api/me', null, 'garbage')).status, 401);
  const t = (await (await call('POST', '/api/auth/register', { name: 'Cy', email: 'cy@example.com', password: 'longenough3' })).json()).token;
  await call('POST', '/api/sessions/bulk', { sessions: [sess('c1')] }, t);
  assert.strictEqual((await call('DELETE', '/api/me', null, t)).status, 200);
  assert.strictEqual((await call('GET', '/api/me', null, t)).status, 401);
  assert.strictEqual((await call('POST', '/api/auth/login', { email: 'cy@example.com', password: 'longenough3' })).status, 401);
});
