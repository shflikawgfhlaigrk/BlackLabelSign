-- Additive recovery. Existing document and participant records are retained.
ALTER TABLE senders ADD COLUMN token_expires_at TEXT;
CREATE TABLE sender_recovery (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT, expires_at TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT, consumed_token TEXT
);
CREATE INDEX idx_sender_recovery_expiry ON sender_recovery(expires_at);

-- A durable request record prevents network retries from duplicating envelopes/quotas.
CREATE TABLE envelope_uploads (
  sender_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  envelope_id TEXT NOT NULL, PRIMARY KEY(sender_id,request_key)
);

ALTER TABLE signers ADD COLUMN auth_delivery_status TEXT;

ALTER TABLE templates ADD COLUMN deletion_claim TEXT;
