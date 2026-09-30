-- 0002: deterministic newest-first ordering for same-day interactions, plus a
-- claim table that makes contact dedupe atomic under concurrent confirms.
--
-- Safe on already-migrated databases: ALTER TABLE appends the column and the
-- UPDATE only touches rows where it is still empty.
ALTER TABLE interactions ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
-- Pre-existing rows have no creation timestamp; the recorded meeting date is
-- the best available ordering value (rowid breaks any remaining ties).
UPDATE interactions SET created_at = interaction_at WHERE created_at = '';

-- One row per canonical contact identifier claim. claim_key is computed
-- app-side as corporation_id|person_name_key|kind|normalized_identifier and
-- claimed inside the same batch as the contacts INSERT, so a losing racer
-- hits the PRIMARY KEY conflict and re-reads the winner instead of inserting
-- a duplicate contact.
CREATE TABLE contact_claims (
  claim_key TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
