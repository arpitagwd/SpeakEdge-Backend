// SQLite storage (single file, no server to install). Set DB_FILE or DATA_DIR to control where it lives.
const fs = require('fs');
const path = require('path');

// Uses Node's built-in SQLite (Node 22.5+): nothing to compile, no Visual Studio needed.
// Falls back to the better-sqlite3 package only if it happens to be installed (older Node).
function loadDriver() {
  try { return require('node:sqlite').DatabaseSync; } catch { /* Node older than 22.5 */ }
  try { return require('better-sqlite3'); } catch { /* not installed */ }
  throw new Error(`SpeakEdge needs Node 22.5 or newer for its built-in database (you have ${process.version}). Install Node 22 LTS from nodejs.org.`);
}
const Database = loadDriver();

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, goal TEXT NOT NULL,
      pass_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      user_id TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (user_id, id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_date ON sessions (user_id, date DESC);`);

  const q = {
    insUser: db.prepare('INSERT INTO users (id,email,name,goal,pass_hash,created_at) VALUES (?,?,?,?,?,?)'),
    byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    updUser: db.prepare('UPDATE users SET name = ?, goal = ? WHERE id = ?'),
    delUser: db.prepare('DELETE FROM users WHERE id = ?'),
    upsert: db.prepare('INSERT INTO sessions (user_id,id,date,data) VALUES (?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET date=excluded.date, data=excluded.data'),
    list: db.prepare('SELECT data FROM sessions WHERE user_id = ? ORDER BY date DESC LIMIT ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?'),
  };
  const upsertMany = (userId, rows) => { // all-or-nothing
    db.exec('BEGIN');
    try { for (const r of rows) q.upsert.run(userId, r.id, r.date, r.data); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return {
    createUser: (u) => q.insUser.run(u.id, u.email, u.name, u.goal, u.passHash, new Date().toISOString()),
    userByEmail: (email) => q.byEmail.get(email),
    userById: (id) => q.byId.get(id),
    updateUser: (id, name, goal) => q.updUser.run(name, goal, id),
    deleteUser: (id) => q.delUser.run(id), // sessions go with it (ON DELETE CASCADE)
    upsertSessions: (userId, rows) => upsertMany(userId, rows),
    listSessions: (userId, limit = 2000) => q.list.all(userId, limit).map((r) => JSON.parse(r.data)),
    countSessions: (userId) => q.count.get(userId).n,
    close: () => db.close(),
  };
}
module.exports = { openDb };
