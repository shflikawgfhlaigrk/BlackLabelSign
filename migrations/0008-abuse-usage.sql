-- Reservations are independent of deletable accounts, envelopes and events.
-- Keys are HMAC pseudonyms; no address, account token or document is stored here.
CREATE TABLE abuse_usage (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  purpose TEXT NOT NULL,
  account_key TEXT NOT NULL,
  network_key TEXT NOT NULL,
  recipient_key TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  used_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_usage_global ON abuse_usage(kind, used_at);
CREATE INDEX idx_usage_account ON abuse_usage(kind, account_key, used_at);
CREATE INDEX idx_usage_network ON abuse_usage(kind, network_key, used_at);
CREATE INDEX idx_usage_recipient ON abuse_usage(kind, recipient_key, purpose, used_at);
CREATE INDEX idx_usage_subject ON abuse_usage(kind, subject_key, purpose, used_at);
