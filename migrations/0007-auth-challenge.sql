-- Preserve outstanding challenges while giving each one a distinct generation.
ALTER TABLE signers ADD COLUMN auth_challenge_id TEXT;
UPDATE signers SET auth_challenge_id=lower(hex(randomblob(16))) WHERE auth_code_hash IS NOT NULL;
