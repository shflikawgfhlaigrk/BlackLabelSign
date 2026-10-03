CREATE TABLE IF NOT EXISTS estate_wholesale_signing (
  packet_id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL UNIQUE,
  sender_email TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_estate_signing_envelope ON estate_wholesale_signing(envelope_id);
