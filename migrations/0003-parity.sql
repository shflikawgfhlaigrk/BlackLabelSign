CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sender_id TEXT,
  key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  pages INTEGER,
  roles_json TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE envelopes ADD COLUMN routing TEXT NOT NULL DEFAULT 'sequential';
ALTER TABLE envelopes ADD COLUMN expires_at TEXT;
ALTER TABLE envelopes ADD COLUMN docs_json TEXT;
ALTER TABLE signers ADD COLUMN role TEXT NOT NULL DEFAULT 'signer';
CREATE INDEX IF NOT EXISTS idx_tpl_sender ON templates(sender_id);
