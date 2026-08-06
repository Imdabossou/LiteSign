const express = require('express');
const session = require('express-session');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const db = require('./db');
const { requireAuth } = require('./auth');
const mailer = require('./mailer');

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const BASE_URL = process.env.BASE_URL || '';
// Number of reverse-proxy hops in front of this app (nginx/Caddy/Cloudflare = 1).
// Needed so req.ip / X-Forwarded-For and secure cookies work when internet-facing.
const TRUST_PROXY = process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY : '1';
app.set('trust proxy', isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY));

// Security headers. CSP is left off because the frontend uses plain inline
// <script> tags (no build step) and loads PDF.js from a CDN — enabling a
// strict default CSP would break the signing/editor pages. Everything else
// helmet sets (X-Content-Type-Options, X-Frame-Options, HSTS, etc.) stays on.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

app.use(express.json({ limit: '25mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12,
    secure: BASE_URL.startsWith('https://'),
    sameSite: 'lax'
  }
}));

// Slow down credential-guessing against the single admin account.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});

// Public signer endpoints are internet-facing and unauthenticated by design
// (the token *is* the credential) — rate-limit them against brute forcing
// or scraping the token space.
const publicSignLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, `${nanoid()}.pdf`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are allowed'));
    cb(null, true);
  }
});

function now() { return new Date().toISOString(); }
function clientIp(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString(); }
function logAudit(documentId, event, detail, ip) {
  db.prepare('INSERT INTO audit_log (document_id, event, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(documentId, event, detail || null, ip || null, now());
}

// ---------- Auth ----------
app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (password && password === ADMIN_PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Incorrect password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed) });
});

app.get('/api/mailer/status', requireAuth, async (req, res) => {
  res.json({ configured: mailer.isConfigured() });
});

// ---------- Documents (admin) ----------
app.post('/api/documents', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const id = nanoid();
  const title = (req.body.title || req.file.originalname || 'Untitled').slice(0, 200);
  db.prepare('INSERT INTO documents (id, title, original_filename, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, title, req.file.filename, 'draft', now());
  logAudit(id, 'document_created', title, clientIp(req));
  res.json({ id });
});

app.get('/api/documents', requireAuth, (req, res) => {
  const docs = db.prepare('SELECT * FROM documents ORDER BY created_at DESC').all();
  const withSigners = docs.map(d => ({
    ...d,
    signers: db.prepare('SELECT id, name, email, status, signed_at FROM signers WHERE document_id = ? ORDER BY order_index').all(d.id)
  }));
  res.json(withSigners);
});

app.get('/api/documents/:id', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const signers = db.prepare('SELECT * FROM signers WHERE document_id = ? ORDER BY order_index').all(doc.id);
  const fields = db.prepare('SELECT * FROM fields WHERE document_id = ?').all(doc.id);
  res.json({ ...doc, signers, fields });
});

app.delete('/api/documents/:id', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM fields WHERE document_id = ?').run(doc.id);
  db.prepare('DELETE FROM signers WHERE document_id = ?').run(doc.id);
  db.prepare('DELETE FROM audit_log WHERE document_id = ?').run(doc.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  [doc.original_filename, `completed_${doc.id}.pdf`].forEach(f => {
    const p = path.join(FILES_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  res.json({ ok: true });
});

app.get('/api/documents/:id/file', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).end();
  res.sendFile(path.join(FILES_DIR, doc.original_filename));
});

app.get('/api/documents/:id/download', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc || doc.status !== 'completed') return res.status(404).json({ error: 'Not completed yet' });
  const p = path.join(FILES_DIR, `completed_${doc.id}.pdf`);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
  res.download(p, `${doc.title.replace(/[^a-z0-9\- _]/gi, '_')}_signed.pdf`);
});

app.get('/api/documents/:id/audit', requireAuth, (req, res) => {
  const logs = db.prepare('SELECT * FROM audit_log WHERE document_id = ? ORDER BY created_at').all(req.params.id);
  res.json(logs);
});

// ---------- Signers (admin) ----------
app.post('/api/documents/:id/signers', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const { name, email } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const id = nanoid();
  const token = nanoid(24);
  const countRow = db.prepare('SELECT COUNT(*) as c FROM signers WHERE document_id = ?').get(doc.id);
  db.prepare('INSERT INTO signers (id, document_id, name, email, token, order_index, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, doc.id, name, email || null, token, countRow.c, 'pending');
  res.json({ id, token });
});

app.delete('/api/signers/:id', requireAuth, (req, res) => {
  const signer = db.prepare('SELECT * FROM signers WHERE id = ?').get(req.params.id);
  if (!signer) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM fields WHERE signer_id = ?').run(signer.id);
  db.prepare('DELETE FROM signers WHERE id = ?').run(signer.id);
  res.json({ ok: true });
});

// ---------- Fields (admin) ----------
app.post('/api/documents/:id/fields', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const { signer_id, type, page, x, y, width, height, label } = req.body || {};
  if (!signer_id || !type || page == null || x == null || y == null) {
    return res.status(400).json({ error: 'Missing field data' });
  }
  const id = nanoid();
  db.prepare(`INSERT INTO fields (id, document_id, signer_id, type, page, x, y, width, height, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, doc.id, signer_id, type, page, x, y, width || 0.18, height || 0.045, label || null);
  res.json({ id });
});

app.delete('/api/fields/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM fields WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/documents/:id/send', requireAuth, async (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const signers = db.prepare('SELECT * FROM signers WHERE document_id = ?').all(doc.id);
  if (signers.length === 0) return res.status(400).json({ error: 'Add at least one signer first' });
  const fieldCount = db.prepare('SELECT COUNT(*) as c FROM fields WHERE document_id = ?').get(doc.id);
  if (fieldCount.c === 0) return res.status(400).json({ error: 'Add at least one field first' });
  db.prepare('UPDATE documents SET status = ? WHERE id = ?').run('pending', doc.id);
  logAudit(doc.id, 'document_sent', `${signers.length} signer(s)`, clientIp(req));

  const note = (req.body && req.body.note) || null;
  const results = [];
  for (const s of signers) {
    const url = `${BASE_URL}/sign.html?token=${s.token}`;
    let emailed = false, emailError = null;
    if (s.email && mailer.isConfigured()) {
      try {
        await mailer.sendSigningRequest({ to: s.email, signerName: s.name, documentTitle: doc.title, signUrl: url, senderNote: note });
        emailed = true;
        logAudit(doc.id, 'email_sent', `signing request to ${s.email}`, clientIp(req));
      } catch (e) {
        emailError = e.message;
        logAudit(doc.id, 'email_failed', `${s.email}: ${e.message}`, clientIp(req));
      }
    }
    results.push({ signer: s.name, email: s.email, url, emailed, emailError });
  }
  res.json({ ok: true, smtpConfigured: mailer.isConfigured(), links: results });
});

app.post('/api/signers/:id/resend', requireAuth, async (req, res) => {
  const signer = db.prepare('SELECT * FROM signers WHERE id = ?').get(req.params.id);
  if (!signer) return res.status(404).json({ error: 'Not found' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(signer.document_id);
  if (signer.status === 'signed') return res.status(400).json({ error: 'This signer has already signed' });
  const url = `${BASE_URL}/sign.html?token=${signer.token}`;
  if (!signer.email) return res.status(400).json({ error: 'This signer has no email on file', url });
  if (!mailer.isConfigured()) return res.status(400).json({ error: 'SMTP is not configured on the server', url });
  try {
    await mailer.sendSigningRequest({ to: signer.email, signerName: signer.name, documentTitle: doc.title, signUrl: url, senderNote: (req.body && req.body.note) || null });
    logAudit(doc.id, 'email_resent', `signing request to ${signer.email}`, clientIp(req));
    res.json({ ok: true, url });
  } catch (e) {
    logAudit(doc.id, 'email_failed', `${signer.email}: ${e.message}`, clientIp(req));
    res.status(500).json({ error: e.message, url });
  }
});

// ---------- Public signer routes (token-based) ----------
function getSignerByToken(token) {
  return db.prepare('SELECT * FROM signers WHERE token = ?').get(token);
}

app.get('/api/sign/:token', publicSignLimiter, (req, res) => {
  const signer = getSignerByToken(req.params.token);
  if (!signer) return res.status(404).json({ error: 'Invalid link' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(signer.document_id);
  const fields = db.prepare('SELECT * FROM fields WHERE signer_id = ? ORDER BY page').all(signer.id);
  res.json({
    document: { id: doc.id, title: doc.title, status: doc.status },
    signer: { id: signer.id, name: signer.name, status: signer.status, signed_at: signer.signed_at },
    fields
  });
});

app.get('/api/sign/:token/file', publicSignLimiter, (req, res) => {
  const signer = getSignerByToken(req.params.token);
  if (!signer) return res.status(404).end();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(signer.document_id);
  res.sendFile(path.join(FILES_DIR, doc.original_filename));
});

app.post('/api/sign/:token/submit', publicSignLimiter, async (req, res) => {
  const signer = getSignerByToken(req.params.token);
  if (!signer) return res.status(404).json({ error: 'Invalid link' });
  if (signer.status === 'signed') return res.status(400).json({ error: 'Already signed' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(signer.document_id);
  const fields = db.prepare('SELECT * FROM fields WHERE signer_id = ?').all(signer.id);
  const { values } = req.body || {};
  if (!Array.isArray(values)) return res.status(400).json({ error: 'Missing values' });

  const valueMap = new Map(values.map(v => [v.field_id, v.value]));
  for (const f of fields) {
    const v = valueMap.get(f.id);
    if (!v || !v.toString().trim()) {
      return res.status(400).json({ error: `Field "${f.label || f.type}" is required` });
    }
  }

  const ip = clientIp(req);
  const tx = db.transaction(() => {
    for (const f of fields) {
      db.prepare('UPDATE fields SET value = ? WHERE id = ?').run(valueMap.get(f.id), f.id);
    }
    db.prepare('UPDATE signers SET status = ?, signed_at = ?, signed_ip = ? WHERE id = ?')
      .run('signed', now(), ip, signer.id);
    logAudit(doc.id, 'signer_signed', signer.name, ip);
  });
  tx();

  const remaining = db.prepare('SELECT COUNT(*) as c FROM signers WHERE document_id = ? AND status != ?').get(doc.id, 'signed');
  if (remaining.c === 0) {
    await finalizeDocument(doc.id);
  }

  res.json({ ok: true, completed: remaining.c === 0 });
});

async function finalizeDocument(documentId) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  const signers = db.prepare('SELECT * FROM signers WHERE document_id = ? ORDER BY order_index').all(documentId);
  const fields = db.prepare('SELECT * FROM fields WHERE document_id = ?').all(documentId);

  const srcBytes = fs.readFileSync(path.join(FILES_DIR, doc.original_filename));
  const pdfDoc = await PDFDocument.load(srcBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  for (const f of fields) {
    const page = pages[f.page];
    if (!page) continue;
    const { width: pw, height: ph } = page.getSize();
    const boxX = f.x * pw;
    const boxWidth = f.width * pw;
    const boxHeight = f.height * ph;
    const boxYTop = f.y * ph; // stored top-down
    const boxY = ph - boxYTop - boxHeight; // pdf-lib origin is bottom-left

    if (f.type === 'signature' || f.type === 'initials') {
      try {
        const dataUrl = f.value;
        const base64 = dataUrl.split(',')[1];
        const imgBytes = Buffer.from(base64, 'base64');
        const png = await pdfDoc.embedPng(imgBytes);
        const scale = Math.min(boxWidth / png.width, boxHeight / png.height);
        const drawW = png.width * scale;
        const drawH = png.height * scale;
        page.drawImage(png, {
          x: boxX + (boxWidth - drawW) / 2,
          y: boxY + (boxHeight - drawH) / 2,
          width: drawW,
          height: drawH
        });
      } catch (e) {
        page.drawText('[signature]', { x: boxX, y: boxY + 4, size: 10, font, color: rgb(0, 0, 0) });
      }
    } else {
      const fontSize = Math.min(12, boxHeight * 0.7);
      page.drawText(String(f.value).slice(0, 200), {
        x: boxX + 2,
        y: boxY + (boxHeight - fontSize) / 2,
        size: fontSize,
        font,
        color: rgb(0.05, 0.05, 0.05)
      });
    }
  }

  // Append audit / certificate page
  const certPage = pdfDoc.addPage();
  const { width: cw } = certPage.getSize();
  let cy = certPage.getHeight() - 60;
  const title = 'Signature Certificate';
  certPage.drawText(title, { x: 50, y: cy, size: 18, font, color: rgb(0, 0, 0) });
  cy -= 30;
  certPage.drawText(`Document: ${doc.title}`, { x: 50, y: cy, size: 11, font });
  cy -= 18;
  certPage.drawText(`Document ID: ${doc.id}`, { x: 50, y: cy, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
  cy -= 18;
  certPage.drawText(`Completed: ${now()}`, { x: 50, y: cy, size: 11, font });
  cy -= 30;

  for (const s of signers) {
    certPage.drawText(`Signer: ${s.name}${s.email ? ' (' + s.email + ')' : ''}`, { x: 50, y: cy, size: 11, font });
    cy -= 16;
    certPage.drawText(`Signed at: ${s.signed_at || '-'}   IP: ${s.signed_ip || '-'}`, { x: 60, y: cy, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
    cy -= 24;
  }

  const finalBytes = await pdfDoc.save();

  const hash = crypto.createHash('sha256').update(finalBytes).digest('hex');
  logAudit(documentId, 'document_completed', `sha256:${hash}`, null);

  fs.writeFileSync(path.join(FILES_DIR, `completed_${documentId}.pdf`), finalBytes);
  db.prepare('UPDATE documents SET status = ?, completed_at = ? WHERE id = ?').run('completed', now(), documentId);

  if (mailer.isConfigured()) {
    for (const s of signers) {
      if (!s.email) continue;
      try {
        await mailer.sendCompletionCopy({
          to: s.email,
          signerName: s.name,
          documentTitle: doc.title,
          downloadNote: 'A copy of the fully signed document is attached.',
          attachment: { filename: `${doc.title.replace(/[^a-z0-9\- _]/gi, '_')}_signed.pdf`, content: finalBytes }
        });
        logAudit(documentId, 'completion_email_sent', s.email, null);
      } catch (e) {
        logAudit(documentId, 'completion_email_failed', `${s.email}: ${e.message}`, null);
      }
    }
  }
}

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'public', '404.html'), err => {
    if (err) res.status(404).send('Not found');
  });
});

app.listen(PORT, () => {
  console.log(`lite-sign listening on port ${PORT}`);
});
