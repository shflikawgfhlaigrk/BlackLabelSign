CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  completed_at TEXT,
  original_key TEXT NOT NULL,
  original_sha256 TEXT NOT NULL,
  final_key TEXT,
  final_sha256 TEXT
);
CREATE TABLE IF NOT EXISTS signers (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  token TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  consent_at TEXT,
  signed_at TEXT,
  ip TEXT,
  ua TEXT
);
CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL,
  signer_id TEXT NOT NULL,
  type TEXT NOT NULL,
  page INTEGER NOT NULL DEFAULT 0,
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL,
  h REAL NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  value TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL,
  signer_id TEXT,
  type TEXT NOT NULL,
  ts TEXT NOT NULL,
  ip TEXT,
  ua TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_signers_env ON signers(envelope_id);
CREATE INDEX IF NOT EXISTS idx_signers_token ON signers(token);
CREATE INDEX IF NOT EXISTS idx_fields_env ON fields(envelope_id);
CREATE INDEX IF NOT EXISTS idx_events_env ON events(envelope_id, ts);
