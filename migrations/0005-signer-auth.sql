ALTER TABLE signers ADD COLUMN auth_code_hash TEXT;
ALTER TABLE signers ADD COLUMN auth_code_expires_at TEXT;
ALTER TABLE signers ADD COLUMN auth_code_sent_at TEXT;
ALTER TABLE signers ADD COLUMN auth_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE signers ADD COLUMN last_authenticated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_signers_auth_code_expires_at ON signers(auth_code_expires_at);
