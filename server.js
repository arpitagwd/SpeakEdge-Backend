require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { openDb } = require('./src/db');
const { computeMetrics, computeScores, ruleFeedback } = require('./src/metrics');
const { aiFeedback, aiConfig } = require('./src/feedback');

const env = (k, d) => Number(process.env[k] || d);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const db = openDb(process.env.DB_FILE || path.join(DATA_DIR, 'speakedge.db'));
// JWT secret: env var in production; otherwise generated once and kept next to the database.
function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, 'jwt.secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* create below */ }
  const v = crypto.randomBytes(48).toString('hex');
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, v, { mode: 0o600 }); } catch { /* in-memory only */ }
  return v;
}
const SECRET = jwtSecret();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Render/Railway/Fly the real client IP comes from the proxy header
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(express.json({ limit: '50kb' }));

// ---- abuse and cost controls (in-memory; fine for one instance) ----
const ipHits = new Map();   // ip -> [timestamps]
const devHits = new Map();  // deviceId -> [timestamps]
const devDay = new Map();   // deviceId -> { day, n }
const today = () => new Date().toISOString().slice(0, 10);
const aiBudget = { day: today(), n: 0 };
const recent = (map, key, windowMs) => { const now = Date.now(); const a = (map.get(key) || []).filter((t) => now - t < windowMs); map.set(key, a); return a; };
setInterval(() => { // keep memory bounded
  const now = Date.now();
  for (const m of [ipHits, devHits]) for (const [k, a] of m) if (!a.length || now - a[a.length - 1] > 60000) m.delete(k);
  for (const [k, v] of devDay) if (v.day !== today()) devDay.delete(k);
}, 300000).unref();

function guard(req, res, next) {
  if (process.env.APP_TOKEN && req.get('x-app-token') !== process.env.APP_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const id = req.get('x-device-id') || '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return res.status(400).json({ error: 'Missing device id' });
  const ip = recent(ipHits, req.ip, 60000);
  if (ip.length >= env('IP_PER_MIN', 300)) return res.status(429).json({ error: 'Too many requests' });
  const d = recent(devHits, id, 60000);
  if (d.length >= env('DEVICE_PER_MIN', 30)) return res.status(429).json({ error: 'Slow down a little' });
  ip.push(Date.now()); d.push(Date.now());
  req.deviceId = id; next();
}
function analyzeQuota(req, res, next) { // the expensive call (AI) has its own daily cap per install
  const day = devDay.get(req.deviceId); const cur = day && day.day === today() ? day : { day: today(), n: 0 };
  if (cur.n >= env('DEVICE_PER_DAY', 60)) return res.status(429).json({ error: 'Daily limit reached. Try again tomorrow.' });
  cur.n++; devDay.set(req.deviceId, cur); next();
}
app.use('/api', guard);

app.get('/health', (_req, res) => res.json({ ok: true, ai: Boolean(aiConfig()), provider: aiConfig()?.name || null, accounts: true }));

app.post('/api/analyze', analyzeQuota, async (req, res) => {
  const { question, category, transcript, durationSec, speakingSec, pauses, typed } = req.body || {};
  if (typeof transcript !== 'string' || !transcript.trim() || transcript.length > 5000) return res.status(400).json({ error: 'Invalid transcript' });
  if (typeof question !== 'string' || typeof category !== 'string' || question.length > 300) return res.status(400).json({ error: 'Invalid question' });
  const dur = Number(durationSec); if (!(dur > 0 && dur <= 180)) return res.status(400).json({ error: 'Invalid duration' });
  const speak = Number(speakingSec) > 0 ? Math.min(Number(speakingSec), dur) : undefined;
  const p = Math.max(0, Math.min(50, Number(pauses) || 0));
  const isTyped = typed === true;

  const metrics = computeMetrics(transcript, dur, p, speak);
  if (aiBudget.day !== today()) { aiBudget.day = today(); aiBudget.n = 0; }
  let feedback = null, content = null;
  if (aiConfig() && aiBudget.n < env('AI_DAILY_BUDGET', 2000)) {
    aiBudget.n++;
    try { ({ feedback, content } = await aiFeedback({ question, category, transcript, metrics, typed: isTyped })); } catch (e) { console.warn('AI call failed, using rule-based tips:', e.message); feedback = null; content = null; }
  }
  if (!feedback) feedback = ruleFeedback(metrics, 'rules', isTyped);
  const scores = computeScores(metrics, transcript, { typed: isTyped, content });
  res.json({ metrics, scores, feedback }); // nothing is stored: transcripts are not persisted server-side
});


// ---------------- accounts + cloud history ----------------
const failures = new Map(); // "ip|email" -> [timestamps] of failed logins
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, goal: u.goal });
const sign = (u) => jwt.sign({ sub: u.id }, SECRET, { expiresIn: '90d' });
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const GOALS = ['placements', 'general'];
const cleanName = (n) => String(n || '').trim().slice(0, 60);
const DUMMY = bcrypt.hashSync('not-a-real-password', 10); // equalises timing for unknown emails

function requireAuth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!m) return res.status(401).json({ error: 'Please sign in' });
  try {
    const { sub } = jwt.verify(m[1], SECRET);
    const u = db.userById(sub); if (!u) throw new Error('gone');
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Session expired. Please sign in again.' }); }
}

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, goal } = req.body || {};
  const n = cleanName(name), e = String(email || '').trim().toLowerCase();
  if (!n) return res.status(400).json({ error: 'Enter your name' });
  if (!EMAIL.test(e)) return res.status(400).json({ error: 'Enter a valid email' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Password must be 8 to 100 characters' });
  if (db.userByEmail(e)) return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });
  const u = { id: crypto.randomUUID(), email: e, name: n, goal: GOALS.includes(goal) ? goal : 'placements', passHash: await bcrypt.hash(password, 10) };
  try { db.createUser(u); } catch { return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' }); }
  res.status(201).json({ token: sign(u), user: publicUser(u) });
});

app.post('/api/auth/login', async (req, res) => {
  const e = String((req.body || {}).email || '').trim().toLowerCase(); const password = String((req.body || {}).password || '');
  const key = `${req.ip}|${e}`; const recentFails = recent(failures, key, 15 * 60000);
  if (recentFails.length >= 8) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const u = db.userByEmail(e);
  const ok = await bcrypt.compare(password, u ? u.pass_hash : DUMMY);
  if (!u || !ok) { recentFails.push(Date.now()); return res.status(401).json({ error: 'Wrong email or password' }); }
  failures.delete(key);
  res.json({ token: sign({ id: u.id }), user: publicUser(u) });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
app.put('/api/me', requireAuth, (req, res) => {
  const n = cleanName((req.body || {}).name) || req.user.name; const g = GOALS.includes((req.body || {}).goal) ? req.body.goal : req.user.goal;
  db.updateUser(req.user.id, n, g); res.json({ user: publicUser({ ...req.user, name: n, goal: g }) });
});
app.delete('/api/me', requireAuth, (req, res) => { db.deleteUser(req.user.id); res.json({ ok: true }); }); // account + all history

app.get('/api/sessions', requireAuth, (req, res) => res.json({ sessions: db.listSessions(req.user.id) }));
app.post('/api/sessions/bulk', requireAuth, (req, res) => {
  const list = (req.body || {}).sessions;
  if (!Array.isArray(list) || list.length === 0 || list.length > 100) return res.status(400).json({ error: 'Send 1 to 100 sessions' });
  const rows = [];
  for (const s of list) {
    const data = JSON.stringify(s || {});
    if (!s || typeof s.id !== 'string' || s.id.length > 40 || !Number.isFinite(Date.parse(s.date)) || typeof s.scores?.overall !== 'number' || data.length > 30000)
      return res.status(400).json({ error: 'Invalid session data' });
    rows.push({ id: s.id, date: new Date(s.date).toISOString(), data });
  }
  if (db.countSessions(req.user.id) + rows.length > 5000) return res.status(413).json({ error: 'History limit reached' });
  db.upsertSessions(req.user.id, rows); res.json({ ok: true, saved: rows.length });
});

// Thumbs up/down + problem reports (no transcript, no user identity).
app.post('/api/feedback', (req, res) => {
  const { sessionId, rating, note } = req.body || {};
  if (!['up', 'down'].includes(rating)) return res.status(400).json({ error: 'Invalid rating' });
  const line = JSON.stringify({ t: new Date().toISOString(), sessionId: String(sessionId || '').slice(0, 40), rating, note: String(note || '').slice(0, 500) });
  console.log('FEEDBACK ' + line); // survives ephemeral disks via platform logs
  const file = path.join(DATA_DIR, 'feedback.jsonl');
  try { if (!fs.existsSync(file) || fs.statSync(file).size < 2e6) fs.appendFile(file, line + '\n', () => {}); } catch { /* best effort */ }
  res.json({ ok: true });
});

module.exports = app;
module.exports.db = db;
if (require.main === module) {
  const port = process.env.PORT || 4000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`SpeakEdge API on :${port} | database: ${process.env.DB_FILE || path.join(DATA_DIR, 'speakedge.db')}`);
    const ai = aiConfig();
    if (ai) console.log(`AI coach: ENABLED via ${ai.name} (${ai.model})`);
    else console.log('AI coach: DISABLED (basic tips only). Add a FREE key to backend/.env, e.g. GROQ_API_KEY=... or GEMINI_API_KEY=... (see .env.example), then restart.');
  });
}
