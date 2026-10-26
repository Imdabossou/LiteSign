const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const config = require('./config');
const db = require('./db');
const { checkAdminPassword, passwordMatches, sessionMiddleware, requireAuth } = require('./auth');
const mailer = require('./mailer');
const { buildSignedPdf } = require('./stamp');

checkAdminPassword();

const { FILES_DIR, BASE_URL } = config;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));

const FIELD_TYPES = ['signature', 'initials', 'text', 'date'];
const MAX_SIGNATURE_BYTES = 512 * 1024;

const app = express();
app.set('trust proxy', config.TRUST_PROXY);
app.disable('x-powered-by');

// Security headers. All scripts are served from this app (no inline script,
// no CDN), so the CSP can lock scripts down to 'self'. PDF.js needs a worker,
// WebAssembly for some image formats, and data:/blob: images.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'script-src': ["'self'", "'wasm-unsafe-eval'"],
      'worker-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'upgrade-insecure-requests': config.SECURE_COOKIES ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '5mb' }));
app.use(sessionMiddleware());

// Defence in depth against cross-site requests: a browser always sends Origin
// on cross-site POST/DELETE, so reject any state-changing API call from a
// different origin. (The SameSite=Lax cookie already blocks most of these.)
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let host;
  try { host = new URL(origin).host; } catch { host = null; }
  const allowed = [req.get('host'), config.BASE_HOST].filter(Boolean);
  if (host && allowed.includes(host)) return next();
  res.status(403).json({ error: 'Cross-origin request blocked' });
});

// Slow down credential-guessing against the single admin account.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Try again later.' }
});

// Public signer endpoints are internet-facing and unauthenticated by design
// (the token *is* the credential), so rate-limit them against brute forcing
// or scraping the token space.
const publicSignLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, `${newId()}.pdf`)
  }),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 5 }
});

function newId(bytes = 12) { return crypto.randomBytes(bytes).toString('base64url'); }
function now() { return new Date().toISOString(); }
// req.ip honours the "trust proxy" setting; reading X-Forwarded-For directly
// would let anyone write whatever IP they like into the audit log.
function clientIp(req) { return (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, ''); }
function signUrl(token) { return `${BASE_URL}/sign.html?token=${token}`; }
function safeFilename(title) { return (title || 'document').replace(/[^a-z0-9\- _]/gi, '_').slice(0, 100); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function logAudit(documentId, event, detail, ip) {
  db.prepare('INSERT INTO audit_log (document_id, event, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(documentId, event, detail || null, ip || null, now());
}

const getDoc = id => db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
const getSigners = docId => db.prepare('SELECT * FROM signers WHERE document_id = ? ORDER BY order_index').all(docId);
const getFields = docId => db.prepare('SELECT * FROM fields WHERE document_id = ?').all(docId);

function loadDoc(req) {
  const doc = getDoc(req.params.id);
  if (!doc) throw httpError(404, 'Not found');
  return doc;
}

function requireDraft(doc) {
  if (doc.status !== 'draft') throw httpError(409, 'This document has already been sent and can no longer be edited');
}

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

// ---------- Health ----------
app.get('/healthz', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

// ---------- Auth ----------
app.post('/api/login', loginLimiter, (req, res, next) => {
  const { password } = req.body || {};
  if (!passwordMatches(password)) return res.status(401).json({ error: 'Incorrect password' });
  // New session ID on login, so a session ID planted before login is useless.
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.authed = true;
    req.session.save(err2 => err2 ? next(err2) : res.json({ ok: true }));
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('litesign.sid');
    res.json({ ok: true });
  });
});

app.get('/api/session', (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed) });
});

app.get('/api/mailer/status', requireAuth, (req, res) => {
  res.json({ configured: mailer.isConfigured() });
});

// ---------- Documents (admin) ----------
app.post('/api/documents', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) throw httpError(400, 'No file uploaded');
  const filePath = req.file.path;
  let pageCount, hash;
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.subarray(0, 1024).indexOf('%PDF-') === -1) throw httpError(400, 'That file is not a PDF');
    try {
      pageCount = (await PDFDocument.load(bytes)).getPageCount();
    } catch (e) {
      throw httpError(400, /encrypt/i.test(e.message)
        ? 'This PDF is password-protected or encrypted. Remove the protection and upload it again.'
        : 'This PDF could not be read. Try re-saving or printing it to a new PDF.');
    }
    if (pageCount === 0) throw httpError(400, 'This PDF has no pages');
    hash = sha256(bytes);
  } catch (e) {
    fs.rmSync(filePath, { force: true });
    throw e;
  }

  const id = newId();
  const title = str(req.body.title, 200) || str(req.file.originalname, 200).replace(/\.pdf$/i, '') || 'Untitled';
  db.prepare(`INSERT INTO documents (id, title, original_filename, status, created_at, page_count, original_sha256)
    VALUES (?, ?, ?, 'draft', ?, ?, ?)`)
    .run(id, title, req.file.filename, now(), pageCount, hash);
  logAudit(id, 'document_created', `${title} (${pageCount} page${pageCount === 1 ? '' : 's'}, sha256:${hash})`, clientIp(req));
  res.json({ id });
});

app.get('/api/documents', requireAuth, (req, res) => {
  const docs = db.prepare('SELECT * FROM documents ORDER BY created_at DESC').all();
  const signerStmt = db.prepare('SELECT id, name, email, status, signed_at, viewed_at FROM signers WHERE document_id = ? ORDER BY order_index');
  res.json(docs.map(d => ({ ...d, signers: signerStmt.all(d.id) })));
});

app.get('/api/documents/:id', requireAuth, (req, res) => {
  const doc = loadDoc(req);
  const signers = getSigners(doc.id).map(s => ({ ...s, url: signUrl(s.token) }));
  const fields = getFields(doc.id).map(({ value, ...f }) => ({ ...f, filled: value != null }));
  res.json({ ...doc, signers, fields, smtpConfigured: mailer.isConfigured() });
});

app.delete('/api/documents/:id', requireAuth, (req, res) => {
  const doc = loadDoc(req);
  db.transaction(() => {
    db.prepare('DELETE FROM fields WHERE document_id = ?').run(doc.id);
    db.prepare('DELETE FROM signers WHERE document_id = ?').run(doc.id);
    db.prepare('DELETE FROM audit_log WHERE document_id = ?').run(doc.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  })();
  for (const f of [doc.original_filename, `completed_${doc.id}.pdf`]) {
    fs.rmSync(path.join(FILES_DIR, path.basename(f)), { force: true });
  }
  res.json({ ok: true });
});

app.get('/api/documents/:id/file', requireAuth, (req, res) => {
  const doc = loadDoc(req);
  res.sendFile(path.join(FILES_DIR, path.basename(doc.original_filename)));
});

app.get('/api/documents/:id/download', requireAuth, (req, res) => {
  const doc = loadDoc(req);
  if (doc.status !== 'completed') throw httpError(404, 'Not completed yet');
  const p = path.join(FILES_DIR, `completed_${doc.id}.pdf`);
  if (!fs.existsSync(p)) throw httpError(404, 'File missing');
  res.download(p, `${safeFilename(doc.title)}_signed.pdf`);
});

app.get('/api/documents/:id/audit', requireAuth, (req, res) => {
  const doc = loadDoc(req);
  res.json(db.prepare('SELECT * FROM audit_log WHERE document_id = ? ORDER BY id').all(doc.id));
});

app.post('/api/documents/:id/void', requireAuth, (req, res) => {
  const doc = loadDoc(req);
  if (doc.status !== 'pending') throw httpError(409, 'Only documents that are out for signing can be cancelled');
  db.prepare("UPDATE documents SET status = 'voided', voided_at = ? WHERE id = ?").run(now(), doc.id);
  logAudit(doc.id, 'document_voided', str(req.body && req.body.reason, 500) || null, clientIp(req));
  res.json({ ok: true });
});

// Re-run completion if it failed part way (e.g. disk full) after everyone signed.
app.post('/api/documents/:id/finalize', requireAuth, async (req, res) => {
  const doc = loadDoc(req);
  if (doc.status !== 'pending') throw httpError(409, 'Document is not awaiting completion');
  const remaining = db.prepare("SELECT COUNT(*) AS c FROM signers WHERE document_id = ? AND status != 'signed'").get(doc.id).c;
  if (remaining > 0) throw httpError(409, 'Not everyone has signed yet');
  await finalizeDocument(doc.id);
  res.json({ ok: true });
});

// ---------- Signers (admin) ----------
app.post('/api/documents/:id/signers', requireAuth, (req, res) => {
  const doc = loadDoc(req);
  requireDraft(doc);
  const name = str(req.body && req.body.name, 200);
  const email = str(req.body && req.body.email, 254);
  if (!name) throw httpError(400, 'Name is required');
  if (email && !EMAIL_RE.test(email)) throw httpError(400, 'That email address doesn\'t look right');
  const id = newId();
  const next = db.prepare('SELECT COALESCE(MAX(order_index) + 1, 0) AS n FROM signers WHERE document_id = ?').get(doc.id).n;
  db.prepare("INSERT INTO signers (id, document_id, name, email, token, order_index, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')")
    .run(id, doc.id, name, email || null, newId(24), next);
  res.json({ id });
});

app.delete('/api/signers/:id', requireAuth, (req, res) => {
  const signer = db.prepare('SELECT * FROM signers WHERE id = ?').get(req.params.id);
  if (!signer) throw httpError(404, 'Not found');
  requireDraft(getDoc(signer.document_id));
  db.transaction(() => {
    db.prepare('DELETE FROM fields WHERE signer_id = ?').run(signer.id);
    db.prepare('DELETE FROM signers WHERE id = ?').run(signer.id);
  })();
  res.json({ ok: true });
});

// ---------- Fields (admin) ----------
function fieldGeometry(body, doc, current = {}) {
  const pick = k => (body[k] !== undefined ? body[k] : current[k]);
  const g = { page: pick('page'), x: pick('x'), y: pick('y'), width: pick('width'), height: pick('height') };
  if (!Number.isInteger(g.page) || g.page < 0 || (doc.page_count != null && g.page >= doc.page_count)) {
    throw httpError(400, 'Invalid page');
  }
  for (const k of ['x', 'y', 'width', 'height']) {
    if (typeof g[k] !== 'number' || !Number.isFinite(g[k]) || g[k] < 0 || g[k] > 1) throw httpError(400, `Invalid ${k}`);
  }
  if (g.width < 0.01 || g.height < 0.005) throw httpError(400, 'Field is too small');
  g.x = Math.min(g.x, 1 - g.width);
  g.y = Math.min(g.y, 1 - g.height);
  return g;
}

app.post('/api/documents/:id/fields', requireAuth, (req, res) => {
  const doc = loadDoc(req);
  requireDraft(doc);
  const body = req.body || {};
  if (!FIELD_TYPES.includes(body.type)) throw httpError(400, 'Invalid field type');
  const signer = db.prepare('SELECT id FROM signers WHERE id = ? AND document_id = ?').get(body.signer_id, doc.id);
  if (!signer) throw httpError(400, 'Unknown signer');
  const g = fieldGeometry(body, doc);
  const id = newId();
  db.prepare(`INSERT INTO fields (id, document_id, signer_id, type, page, x, y, width, height, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, doc.id, signer.id, body.type, g.page, g.x, g.y, g.width, g.height, str(body.label, 100) || null);
  res.json({ id });
});

app.patch('/api/fields/:id', requireAuth, (req, res) => {
  const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(req.params.id);
  if (!field) throw httpError(404, 'Not found');
  const doc = getDoc(field.document_id);
  requireDraft(doc);
  const body = req.body || {};
  const g = fieldGeometry(body, doc, field);
  const label = body.label !== undefined ? (str(body.label, 100) || null) : field.label;
  db.prepare('UPDATE fields SET page = ?, x = ?, y = ?, width = ?, height = ?, label = ? WHERE id = ?')
    .run(g.page, g.x, g.y, g.width, g.height, label, field.id);
  res.json({ ok: true });
});

app.delete('/api/fields/:id', requireAuth, (req, res) => {
  const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(req.params.id);
  if (!field) throw httpError(404, 'Not found');
  requireDraft(getDoc(field.document_id));
  db.prepare('DELETE FROM fields WHERE id = ?').run(field.id);
  res.json({ ok: true });
});

// ---------- Sending ----------
async function emailSigner(doc, signer, note, ip, event) {
  const url = signUrl(signer.token);
  if (!signer.email || !mailer.isConfigured()) return { emailed: false, emailError: null };
  try {
    await mailer.sendSigningRequest({ to: signer.email, signerName: signer.name, documentTitle: doc.title, signUrl: url, senderNote: note });
    logAudit(doc.id, event, `signing request to ${signer.email}`, ip);
    return { emailed: true, emailError: null };
  } catch (e) {
    logAudit(doc.id, 'email_failed', `${signer.email}: ${e.message}`, ip);
    return { emailed: false, emailError: e.message };
  }
}

app.post('/api/documents/:id/send', requireAuth, async (req, res) => {
  const doc = loadDoc(req);
  requireDraft(doc);
  const signers = getSigners(doc.id);
  if (signers.length === 0) throw httpError(400, 'Add at least one signer first');
  const counts = db.prepare('SELECT signer_id, COUNT(*) AS c FROM fields WHERE document_id = ? GROUP BY signer_id').all(doc.id);
  const withFields = new Set(counts.map(r => r.signer_id));
  const missing = signers.filter(s => !withFields.has(s.id));
  if (missing.length) {
    throw httpError(400, `Place at least one field for ${missing.map(s => s.name).join(', ')}`);
  }

  // Flip to pending before the (slow) emails go out, so a double-click can't send twice.
  const changed = db.prepare("UPDATE documents SET status = 'pending', sent_at = ? WHERE id = ? AND status = 'draft'").run(now(), doc.id);
  if (changed.changes === 0) throw httpError(409, 'This document has already been sent');
  const ip = clientIp(req);
  logAudit(doc.id, 'document_sent', `${signers.length} signer(s)`, ip);

  const note = str(req.body && req.body.note, 1000) || null;
  const links = [];
  for (const s of signers) {
    const result = await emailSigner(doc, s, note, ip, 'email_sent');
    links.push({ signer: s.name, email: s.email, url: signUrl(s.token), ...result });
  }
  res.json({ ok: true, smtpConfigured: mailer.isConfigured(), links });
});

app.post('/api/signers/:id/resend', requireAuth, async (req, res) => {
  const signer = db.prepare('SELECT * FROM signers WHERE id = ?').get(req.params.id);
  if (!signer) throw httpError(404, 'Not found');
  const doc = getDoc(signer.document_id);
  const url = signUrl(signer.token);
  if (doc.status !== 'pending') return res.status(409).json({ error: 'This document is not out for signing', url });
  if (signer.status === 'signed') return res.status(400).json({ error: 'This signer has already signed', url });
  if (!signer.email) return res.status(400).json({ error: 'This signer has no email on file', url });
  if (!mailer.isConfigured()) return res.status(400).json({ error: 'SMTP is not configured on the server', url });
  const result = await emailSigner(doc, signer, str(req.body && req.body.note, 1000) || null, clientIp(req), 'email_resent');
  if (!result.emailed) return res.status(502).json({ error: result.emailError, url });
  res.json({ ok: true, url });
});

// ---------- Public signer routes (token-based) ----------
const signRouter = express.Router({ mergeParams: true });
app.use('/api/sign/:token', publicSignLimiter, signRouter);

signRouter.use((req, res, next) => {
  const signer = db.prepare('SELECT * FROM signers WHERE token = ?').get(req.params.token);
  const doc = signer && getDoc(signer.document_id);
  // Links aren't live until the document is sent.
  if (!signer || !doc || doc.status === 'draft') return res.status(404).json({ error: 'Invalid link' });
  req.signer = signer;
  req.doc = doc;
  next();
});

signRouter.get('/', (req, res) => {
  const { signer, doc } = req;
  if (!signer.viewed_at && doc.status === 'pending') {
    const t = now();
    db.prepare('UPDATE signers SET viewed_at = ? WHERE id = ?').run(t, signer.id);
    signer.viewed_at = t;
    logAudit(doc.id, 'signer_viewed', signer.name, clientIp(req));
  }
  const fields = db.prepare('SELECT id, type, page, x, y, width, height, label FROM fields WHERE signer_id = ? ORDER BY page, y, x').all(signer.id);
  res.json({
    document: { title: doc.title, status: doc.status },
    signer: { name: signer.name, status: signer.status, signed_at: signer.signed_at },
    fields
  });
});

signRouter.get('/file', (req, res) => {
  if (req.doc.status === 'voided') return res.status(410).json({ error: 'This document has been cancelled' });
  res.sendFile(path.join(FILES_DIR, path.basename(req.doc.original_filename)));
});

// Signers can download the finished copy too, e.g. if they gave no email address.
signRouter.get('/download', (req, res) => {
  const { doc } = req;
  const p = path.join(FILES_DIR, `completed_${doc.id}.pdf`);
  if (doc.status !== 'completed' || !fs.existsSync(p)) return res.status(404).json({ error: 'Not completed yet' });
  res.download(p, `${safeFilename(doc.title)}_signed.pdf`);
});

function validValue(field, value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (field.type === 'signature' || field.type === 'initials') {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!m) return false;
    const bytes = Buffer.from(m[1], 'base64');
    return bytes.length <= MAX_SIGNATURE_BYTES && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return value.length <= (field.type === 'date' ? 50 : 500);
}

signRouter.post('/submit', async (req, res) => {
  const { signer, doc } = req;
  if (signer.status === 'signed') throw httpError(400, 'You have already signed this document');
  if (doc.status !== 'pending') throw httpError(409, doc.status === 'voided' ? 'This document has been cancelled' : 'This document is no longer accepting signatures');
  const { values, consent } = req.body || {};
  if (consent !== true) throw httpError(400, 'Please agree to sign electronically');
  if (!Array.isArray(values)) throw httpError(400, 'Missing values');

  const fields = db.prepare('SELECT * FROM fields WHERE signer_id = ?').all(signer.id);
  const valueMap = new Map(values.filter(v => v && typeof v === 'object').map(v => [v.field_id, v.value]));
  for (const f of fields) {
    if (!validValue(f, valueMap.get(f.id))) throw httpError(400, `Field "${f.label || f.type}" is missing or invalid`);
  }

  const ip = clientIp(req);
  const signed = db.transaction(() => {
    // Re-check inside the transaction so a double submit can't sign twice.
    const r = db.prepare("UPDATE signers SET status = 'signed', signed_at = ?, signed_ip = ? WHERE id = ? AND status != 'signed'")
      .run(now(), ip, signer.id);
    if (r.changes === 0) return false;
    const setValue = db.prepare('UPDATE fields SET value = ? WHERE id = ?');
    for (const f of fields) setValue.run(String(valueMap.get(f.id)).trim(), f.id);
    logAudit(doc.id, 'signer_consented', `${signer.name} agreed to sign electronically`, ip);
    logAudit(doc.id, 'signer_signed', signer.name, ip);
    return true;
  })();
  if (!signed) throw httpError(400, 'You have already signed this document');

  const remaining = db.prepare("SELECT COUNT(*) AS c FROM signers WHERE document_id = ? AND status != 'signed'").get(doc.id).c;
  let completed = false;
  if (remaining === 0) {
    try {
      await finalizeDocument(doc.id);
      completed = true;
    } catch (e) {
      // The signature itself is saved; the sender can retry completion from the dashboard.
      console.error(`[finalize] ${doc.id}:`, e);
      logAudit(doc.id, 'completion_failed', e.message, null);
    }
  }
  res.json({ ok: true, completed });
});

async function finalizeDocument(documentId) {
  const doc = getDoc(documentId);
  const signers = getSigners(documentId);
  const fields = getFields(documentId);
  const completedAt = now();

  const srcBytes = fs.readFileSync(path.join(FILES_DIR, path.basename(doc.original_filename)));
  const finalBytes = await buildSignedPdf({ srcBytes, doc, signers, fields, completedAt });
  const hash = sha256(finalBytes);

  const outPath = path.join(FILES_DIR, `completed_${documentId}.pdf`);
  fs.writeFileSync(`${outPath}.tmp`, finalBytes);
  fs.renameSync(`${outPath}.tmp`, outPath);
  db.prepare("UPDATE documents SET status = 'completed', completed_at = ?, completed_sha256 = ? WHERE id = ?")
    .run(completedAt, hash, documentId);
  logAudit(documentId, 'document_completed', `sha256:${hash}`, null);

  if (mailer.isConfigured()) {
    for (const s of signers) {
      if (!s.email) continue;
      try {
        await mailer.sendCompletionCopy({
          to: s.email,
          signerName: s.name,
          documentTitle: doc.title,
          downloadNote: 'A copy of the fully signed document is attached.',
          attachment: { filename: `${safeFilename(doc.title)}_signed.pdf`, content: Buffer.from(finalBytes) }
        });
        logAudit(documentId, 'completion_email_sent', s.email, null);
      } catch (e) {
        logAudit(documentId, 'completion_email_failed', `${s.email}: ${e.message}`, null);
      }
    }
  }
}

// ---------- Static frontend ----------
// PDF.js is served from the installed npm package, so signers' browsers never
// touch a third-party CDN.
for (const dir of ['build', 'cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  app.use(`/vendor/pdfjs/${dir}`, express.static(path.join(PDFJS_DIR, dir), { maxAge: '7d', immutable: true }));
}
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'), err => {
    if (err && !res.headersSent) res.send('Not found');
  });
});

// Every error becomes a JSON response the frontend can show, instead of an
// HTML stack trace.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  let status = err.status || err.statusCode || 500;
  let message = err.expose ? err.message : 'Something went wrong';
  if (err instanceof multer.MulterError) {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${config.MAX_UPLOAD_MB} MB)` : err.message;
  } else if (err.type === 'entity.too.large') {
    message = 'Request is too large';
  }
  if (status >= 500) console.error(err);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: message });
});

const server = app.listen(config.PORT, () => {
  console.log(`LiteSign listening on port ${config.PORT}`);
  if (!BASE_URL) console.warn('[config] BASE_URL is not set; signing links will be relative and won\'t work in emails.');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
