CREATE TABLE IF NOT EXISTS source_artifacts (
  source TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  PRIMARY KEY (source, sha256),
  CONSTRAINT source_artifacts_source_check CHECK (source IN ('directory','claude_usage','claude_cost','gemini_billing')),
  CONSTRAINT source_artifacts_byte_length_check CHECK (byte_length >= 0)
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  directory_sha256 TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  rows_total INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  replayed INTEGER NOT NULL,
  duplicates INTEGER NOT NULL,
  conflicts INTEGER NOT NULL,
  restatements INTEGER NOT NULL,
  quarantined INTEGER NOT NULL,
  prior_keys_absent INTEGER NOT NULL,
  checks_failed INTEGER NOT NULL,
  checks_not_run INTEGER NOT NULL,
  exclusions_affect_tokens INTEGER NOT NULL,
  exclusions_affect_money INTEGER NOT NULL,
  exclusions_unmeasurable INTEGER NOT NULL,
  CONSTRAINT ingestion_runs_status_check CHECK (status IN ('complete','complete_with_exclusions')),
  CONSTRAINT ingestion_runs_non_negative_check CHECK (
    rows_total >= 0 AND accepted >= 0 AND replayed >= 0 AND duplicates >= 0 AND conflicts >= 0
    AND restatements >= 0 AND quarantined >= 0 AND prior_keys_absent >= 0
    AND checks_failed >= 0 AND checks_not_run >= 0
  ),
  CONSTRAINT ingestion_runs_exclusion_flags_check CHECK (
    exclusions_affect_tokens IN (0, 1) AND exclusions_affect_money IN (0, 1)
    AND exclusions_unmeasurable IN (0, 1)
  )
);
CREATE INDEX IF NOT EXISTS ingestion_runs_recorded_at_idx ON ingestion_runs (recorded_at);

CREATE TABLE IF NOT EXISTS directory_snapshots (
  sha256 TEXT PRIMARY KEY,
  first_seen_run_id INTEGER,
  CONSTRAINT directory_snapshots_first_seen_run_id_fk FOREIGN KEY (first_seen_run_id)
    REFERENCES ingestion_runs (id) ON DELETE RESTRICT,
  CONSTRAINT directory_snapshots_first_seen_run_id_unique UNIQUE (first_seen_run_id)
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS active_source_rows (
  key_digest TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  directory_sha256 TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  CONSTRAINT active_source_rows_source_check CHECK (source IN ('claude_usage','claude_cost','gemini_billing')),
  CONSTRAINT active_source_rows_row_index_check CHECK (row_index >= 0),
  CONSTRAINT active_source_rows_artifact_fk FOREIGN KEY (source, artifact_sha256)
    REFERENCES source_artifacts (source, sha256) ON DELETE RESTRICT,
  CONSTRAINT active_source_rows_directory_fk FOREIGN KEY (directory_sha256)
    REFERENCES directory_snapshots (sha256) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS active_source_rows_source_artifact_idx
  ON active_source_rows (source, artifact_sha256);
CREATE INDEX IF NOT EXISTS active_source_rows_directory_idx
  ON active_source_rows (directory_sha256);

CREATE TABLE IF NOT EXISTS usage_observations (
  key_digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  period_day TEXT NOT NULL,
  iso_week TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension_kind TEXT NOT NULL,
  dimension_name TEXT NOT NULL,
  uncached_input INTEGER,
  cache_read_input INTEGER,
  cache_creation_5m_input INTEGER,
  cache_creation_1h_input INTEGER,
  output INTEGER,
  input_total INTEGER,
  requests_count INTEGER,
  web_search_requests_count INTEGER,
  direction TEXT,
  tokens INTEGER,
  PRIMARY KEY (key_digest, ordinal),
  CONSTRAINT usage_observations_active_fk FOREIGN KEY (key_digest)
    REFERENCES active_source_rows (key_digest) ON DELETE RESTRICT,
  CONSTRAINT usage_observations_user_fk FOREIGN KEY (user_id)
    REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT usage_observations_group_fk FOREIGN KEY (group_id)
    REFERENCES groups (group_id) ON DELETE RESTRICT,
  CONSTRAINT usage_platform_check CHECK (platform IN ('claude','gemini')),
  CONSTRAINT usage_dimension_kind_check CHECK (dimension_kind IN ('product','workload')),
  CONSTRAINT usage_direction_check CHECK (direction IS NULL OR direction IN ('input','output')),
  CONSTRAINT usage_non_negative_check CHECK (
    ordinal >= 0
    AND (uncached_input IS NULL OR uncached_input >= 0)
    AND (cache_read_input IS NULL OR cache_read_input >= 0)
    AND (cache_creation_5m_input IS NULL OR cache_creation_5m_input >= 0)
    AND (cache_creation_1h_input IS NULL OR cache_creation_1h_input >= 0)
    AND (output IS NULL OR output >= 0)
    AND (input_total IS NULL OR input_total >= 0)
    AND (requests_count IS NULL OR requests_count >= 0)
    AND (web_search_requests_count IS NULL OR web_search_requests_count >= 0)
    AND (tokens IS NULL OR tokens >= 0)
  ),
  CONSTRAINT usage_claude_total_check CHECK (
    input_total IS NULL OR input_total = uncached_input + cache_read_input + cache_creation_5m_input + cache_creation_1h_input
  ),
  CONSTRAINT usage_platform_shape_check CHECK (
    (
      platform = 'claude'
      AND dimension_kind = 'product'
      AND direction IS NULL
      AND tokens IS NULL
      AND uncached_input IS NOT NULL
      AND cache_read_input IS NOT NULL
      AND cache_creation_5m_input IS NOT NULL
      AND cache_creation_1h_input IS NOT NULL
      AND output IS NOT NULL
      AND input_total IS NOT NULL
      AND requests_count IS NOT NULL
      AND web_search_requests_count IS NOT NULL
    ) OR (
      platform = 'gemini'
      AND dimension_kind = 'workload'
      AND direction IN ('input','output')
      AND tokens IS NOT NULL
      AND uncached_input IS NULL
      AND cache_read_input IS NULL
      AND cache_creation_5m_input IS NULL
      AND cache_creation_1h_input IS NULL
      AND output IS NULL
      AND input_total IS NULL
      AND requests_count IS NULL
      AND web_search_requests_count IS NULL
    )
  )
);
CREATE INDEX IF NOT EXISTS usage_platform_period_idx ON usage_observations (platform, period_day);
CREATE INDEX IF NOT EXISTS usage_group_period_idx ON usage_observations (group_id, period_day);
CREATE INDEX IF NOT EXISTS usage_user_period_idx ON usage_observations (user_id, period_day);
CREATE INDEX IF NOT EXISTS usage_platform_group_week_idx ON usage_observations (platform, group_id, iso_week);

CREATE TABLE IF NOT EXISTS charge_observations (
  key_digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  period_day TEXT NOT NULL,
  iso_week TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension_kind TEXT NOT NULL,
  dimension_name TEXT NOT NULL,
  charge_kind TEXT,
  direction TEXT,
  amount_usd_e8 INTEGER NOT NULL,
  PRIMARY KEY (key_digest, ordinal),
  CONSTRAINT charge_observations_active_fk FOREIGN KEY (key_digest)
    REFERENCES active_source_rows (key_digest) ON DELETE RESTRICT,
  CONSTRAINT charge_observations_user_fk FOREIGN KEY (user_id)
    REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT charge_observations_group_fk FOREIGN KEY (group_id)
    REFERENCES groups (group_id) ON DELETE RESTRICT,
  CONSTRAINT charge_platform_check CHECK (platform IN ('claude','gemini')),
  CONSTRAINT charge_dimension_kind_check CHECK (dimension_kind IN ('product','workload')),
  CONSTRAINT charge_direction_check CHECK (direction IS NULL OR direction IN ('input','output')),
  CONSTRAINT charge_kind_check CHECK (charge_kind IS NULL OR charge_kind IN ('tokens','web_search')),
  CONSTRAINT charge_amount_check CHECK (amount_usd_e8 >= 0),
  CONSTRAINT charge_platform_shape_check CHECK (
    (
      platform = 'claude'
      AND dimension_kind = 'product'
      AND charge_kind IN ('tokens','web_search')
      AND direction IS NULL
    ) OR (
      platform = 'gemini'
      AND dimension_kind = 'workload'
      AND charge_kind IS NULL
      AND direction IN ('input','output')
    )
  )
);
CREATE INDEX IF NOT EXISTS charge_platform_period_idx ON charge_observations (platform, period_day);
CREATE INDEX IF NOT EXISTS charge_group_period_idx ON charge_observations (group_id, period_day);
CREATE INDEX IF NOT EXISTS charge_platform_group_week_idx ON charge_observations (platform, group_id, iso_week);

CREATE TABLE IF NOT EXISTS run_excluded_rows (
  run_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  key_digest TEXT,
  fingerprint TEXT NOT NULL,
  disposition TEXT NOT NULL,
  reason_code TEXT,
  PRIMARY KEY (run_id, source, artifact_sha256, row_index),
  CONSTRAINT run_excluded_rows_run_fk FOREIGN KEY (run_id)
    REFERENCES ingestion_runs (id) ON DELETE RESTRICT,
  CONSTRAINT run_excluded_rows_source_check CHECK (source IN ('claude_usage','claude_cost','gemini_billing')),
  CONSTRAINT run_excluded_rows_row_index_check CHECK (row_index >= 0),
  CONSTRAINT run_excluded_rows_disposition_check CHECK (disposition IN ('duplicate','conflict','restatement','quarantined'))
);
CREATE INDEX IF NOT EXISTS run_excluded_rows_run_idx ON run_excluded_rows (run_id);

CREATE TABLE IF NOT EXISTS capability_state (
  group_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at TEXT,
  updated_by TEXT,
  PRIMARY KEY (group_id, capability),
  CONSTRAINT capability_state_group_fk FOREIGN KEY (group_id)
    REFERENCES groups (group_id) ON DELETE RESTRICT,
  CONSTRAINT capability_state_capability_check CHECK (capability IN ('usage-connector','web-search','code-execution')),
  CONSTRAINT capability_state_enabled_check CHECK (enabled IN (0, 1)),
  CONSTRAINT capability_state_updated_metadata_check CHECK (
    (updated_at IS NULL AND updated_by IS NULL)
    OR (updated_at IS NOT NULL AND updated_by IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS capability_state_group_idx ON capability_state (group_id);
