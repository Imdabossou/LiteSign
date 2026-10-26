const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

fs.mkdirSync(config.FILES_DIR, { recursive: true });

const db = new Database(path.join(config.DATA_DIR, 'litesign.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | pending | completed | voided
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS signers (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  token TEXT NOT NULL UNIQUE,
  order_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | signed
  signed_at TEXT,
  signed_ip TEXT,
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  signer_id TEXT NOT NULL,
  type TEXT NOT NULL, -- signature | initials | text | date
  page INTEGER NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  label TEXT,
  value TEXT,
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY(signer_id) REFERENCES signers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signers_document ON signers(document_id);
CREATE INDEX IF NOT EXISTS idx_fields_document ON fields(document_id);
CREATE INDEX IF NOT EXISTS idx_fields_signer ON fields(signer_id);
CREATE INDEX IF NOT EXISTS idx_audit_document ON audit_log(document_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
`);

// Columns added after the first release. CREATE TABLE IF NOT EXISTS won't add
// them to an existing database, so add any that are missing.
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('documents', 'page_count', 'INTEGER');
addColumn('documents', 'original_sha256', 'TEXT');
addColumn('documents', 'completed_sha256', 'TEXT');
addColumn('documents', 'sent_at', 'TEXT');
addColumn('documents', 'voided_at', 'TEXT');
addColumn('signers', 'viewed_at', 'TEXT');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

module.exports = db;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
