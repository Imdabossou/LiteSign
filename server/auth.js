const crypto = require('crypto');
const session = require('express-session');
const config = require('./config');
const db = require('./db');

// The admin password must be set explicitly. The old example config shipped
// "changeme", so refuse that too rather than run an internet-facing app with it.
function checkAdminPassword() {
  const pw = config.ADMIN_PASSWORD;
  if (!pw || pw === 'changeme') {
    console.error('[auth] ADMIN_PASSWORD is not set (or is still "changeme"). ' +
      'Set it to a long random value in your .env or environment and restart.');
    process.exit(1);
  }
  if (pw.length < 12) {
    console.warn('[auth] ADMIN_PASSWORD is shorter than 12 characters. Consider a longer one; this app is meant to be internet-facing.');
  }
}

function passwordMatches(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(config.ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Use SESSION_SECRET if given, otherwise generate one once and keep it in the
// database so restarts don't log everyone out.
function sessionSecret() {
  if (config.SESSION_SECRET) return config.SESSION_SECRET;
  let secret = db.getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    db.setSetting('session_secret', secret);
  }
  return secret;
}

// Sessions live in the same SQLite file as everything else, instead of
// express-session's default MemoryStore (which leaks and forgets on restart).
class SqliteStore extends session.Store {
  constructor() {
    super();
    this.getStmt = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = db.prepare(`INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`);
    this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires <= ?');
    this.pruneTimer = setInterval(() => this.pruneStmt.run(Date.now()), 60 * 60 * 1000);
    this.pruneTimer.unref();
  }

  expiry(sess) {
    const maxAge = sess.cookie && sess.cookie.maxAge;
    return Date.now() + (typeof maxAge === 'number' ? maxAge : 24 * 60 * 60 * 1000);
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.expiry(sess));
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }

  touch(sid, sess, cb) {
    try {
      this.touchStmt.run(this.expiry(sess), sid);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
}

function sessionMiddleware() {
  return session({
    name: 'litesign.sid',
    secret: sessionSecret(),
    store: new SqliteStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 12,
      secure: config.SECURE_COOKIES,
      sameSite: 'lax'
    }
  });
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login.html');
}

module.exports = { checkAdminPassword, passwordMatches, sessionMiddleware, requireAuth };
