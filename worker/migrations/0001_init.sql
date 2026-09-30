-- meishi-app D1 schema: corporations / contacts / business_cards / interactions.
-- name_key columns hold the app-computed lookup keys (legal-form stripped for
-- corporations, whitespace-stripped for contacts) so searches stay durable and
-- indexable without recomputing normalization in SQL.
CREATE TABLE corporations (
  corporation_id TEXT PRIMARY KEY,
  -- '' when unverified/unknown; the partial unique index enforces dedupe on
  -- real 13-digit numbers even under concurrent registration.
  corporate_number TEXT NOT NULL DEFAULT '',
  official_name TEXT NOT NULL,
  name_key TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_corporations_number
  ON corporations(corporate_number) WHERE corporate_number <> '';
-- Same-name rows with no corporate_number dedupe onto each other; the index
-- makes that hold under concurrent registration, not just sequentially.
CREATE UNIQUE INDEX idx_corporations_unnumbered_name_key
  ON corporations(name_key) WHERE corporate_number = '' AND name_key <> '';
CREATE INDEX idx_corporations_name_key ON corporations(name_key);

CREATE TABLE contacts (
  person_id TEXT PRIMARY KEY,
  corporation_id TEXT NOT NULL REFERENCES corporations(corporation_id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_contacts_corporation ON contacts(corporation_id);
CREATE INDEX idx_contacts_name_key ON contacts(name_key);

CREATE TABLE business_cards (
  business_card_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES contacts(person_id),
  corporation_id TEXT NOT NULL,
  image_reference TEXT NOT NULL DEFAULT '',
  captured_at TEXT NOT NULL,
  raw_extraction TEXT NOT NULL DEFAULT '',
  confirmed_data TEXT NOT NULL DEFAULT '',
  decision_confidence REAL NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'confirmed'
);
CREATE INDEX idx_business_cards_person ON business_cards(person_id);
CREATE INDEX idx_business_cards_corporation ON business_cards(corporation_id);

CREATE TABLE interactions (
  interaction_id TEXT PRIMARY KEY,
  corporation_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  interaction_type TEXT NOT NULL DEFAULT '',
  interaction_at TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_interactions_person ON interactions(person_id);
CREATE INDEX idx_interactions_corporation ON interactions(corporation_id);
CREATE INDEX idx_interactions_at ON interactions(interaction_at);
