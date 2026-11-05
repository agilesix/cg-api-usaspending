-- The D1 schema for the full-coverage awards API.
--
-- Conventions, following cg-api-ca:
--   - `id` is the CommonGrants UUID the API serves.
--   - `record_json` holds the full CommonGrants record, so reads never rebuild
--     it from columns. The other columns exist to filter and sort in SQL.
--   - Money is stored as integer cents next to its currency.
--   - Timestamps used for filtering and sorting are integer milliseconds since
--     the epoch (UTC), so comparisons match the in-memory repositories exactly.
--   - `source_version` is the upstream "last changed" marker; `raw_hash` is a
--     hash of the raw upstream record. A record is refetched when the first
--     changes and re-archived only when the second does.

CREATE TABLE IF NOT EXISTS opportunities (
  id                        TEXT PRIMARY KEY,
  fon                       TEXT NOT NULL,
  fon_norm                  TEXT NOT NULL,
  title                     TEXT NOT NULL,
  status                    TEXT NOT NULL,
  created_at                INTEGER NOT NULL,
  last_modified_at          INTEGER NOT NULL,
  close_date                INTEGER,
  total_available_cents     INTEGER,
  total_available_currency  TEXT,
  min_award_cents           INTEGER,
  min_award_currency        TEXT,
  max_award_cents           INTEGER,
  max_award_currency        TEXT,
  estimated_award_count     INTEGER,
  -- The version marker from the latest listing, and the one the stored record
  -- was fetched at. They differ when the record needs fetching.
  listed_version            TEXT,
  source_version            TEXT,
  raw_hash                  TEXT,
  record_json               TEXT,
  seen_run                  TEXT,
  synced_at                 TEXT,
  -- When the stored record last actually changed. Awards embed the
  -- opportunity's title and identifiers, so they are rebuilt after this.
  changed_at                TEXT
);

CREATE INDEX IF NOT EXISTS idx_opportunities_fon_norm ON opportunities(fon_norm);
CREATE INDEX IF NOT EXISTS idx_opportunities_last_modified ON opportunities(last_modified_at);

CREATE TABLE IF NOT EXISTS awards (
  id                  TEXT PRIMARY KEY,
  source_key          TEXT UNIQUE NOT NULL,
  opportunity_id      TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  last_modified_at    INTEGER NOT NULL,
  award_date          INTEGER,
  pop_end             TEXT,
  awarded_cents       INTEGER,
  awarded_currency    TEXT,
  source_version      TEXT,
  raw_hash            TEXT,
  record_json         TEXT NOT NULL,
  synced_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_awards_opportunity ON awards(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_awards_last_modified ON awards(last_modified_at);

-- The awards a refresh found in the USAspending download that link to a stored
-- opportunity. Staging for the detail lookups, which run in batches.
CREATE TABLE IF NOT EXISTS award_candidates (
  source_key      TEXT PRIMARY KEY,
  opportunity_id  TEXT NOT NULL,
  fon             TEXT NOT NULL,
  match_method    TEXT NOT NULL,
  source_version  TEXT,
  run_id          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_award_candidates_run ON award_candidates(run_id);

-- One row per refresh: when it ran, whether it finished, and what it counted.
CREATE TABLE IF NOT EXISTS sync_runs (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,
  report_json  TEXT,
  error        TEXT
);
