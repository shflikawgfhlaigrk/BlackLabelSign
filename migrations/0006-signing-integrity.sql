-- Additive migration; deploy the matching Worker before enabling mutations.
ALTER TABLE envelopes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE envelopes ADD COLUMN mutation_id TEXT;
ALTER TABLE fields ADD COLUMN signature_key TEXT;
-- Retain every accepted immutable object until envelope deletion, including
-- earlier draft originals. Legacy original/final/signature keys remain readable.
CREATE TABLE envelope_objects (
  envelope_id TEXT NOT NULL,
  key TEXT PRIMARY KEY,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_envelope_objects_env ON envelope_objects(envelope_id);
