CREATE TABLE IF NOT EXISTS senders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  ip TEXT,
  created_at TEXT NOT NULL
);
ALTER TABLE envelopes ADD COLUMN sender_id TEXT;
CREATE INDEX IF NOT EXISTS idx_senders_token ON senders(token);
CREATE INDEX IF NOT EXISTS idx_senders_email ON senders(email);
CREATE INDEX IF NOT EXISTS idx_env_sender ON envelopes(sender_id);
