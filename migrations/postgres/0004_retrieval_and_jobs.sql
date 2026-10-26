-- One row per retrieval: every candidate's features, the profile version used and what was returned.
CREATE TABLE IF NOT EXISTS retrieval_log (
  id                     UUID PRIMARY KEY,
  workspace_id           TEXT        NOT NULL,
  trace_id               TEXT        NOT NULL,
  actor_type             TEXT        NOT NULL,
  actor_id               TEXT        NOT NULL,
  query_text             TEXT        NOT NULL,
  query_hash             TEXT        NOT NULL,
  filter                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
  profile_name           TEXT        NOT NULL,
  profile_version        INTEGER     NOT NULL,
  profile_served         TEXT        NOT NULL CHECK (profile_served IN ('active', 'canary')),
  shadow_profile_version INTEGER,
  candidates             JSONB       NOT NULL,
  shadow_results         JSONB,
  results                JSONB       NOT NULL,
  stats                  JSONB       NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retrieval_log_workspace_created_idx ON retrieval_log (workspace_id, created_at DESC);

-- Every background job run, and the guard that allows one running run per job and workspace.
CREATE TABLE IF NOT EXISTS job_runs (
  id           UUID PRIMARY KEY,
  job_name     TEXT        NOT NULL,
  workspace_id TEXT        NOT NULL,
  trace_id     TEXT        NOT NULL,
  trigger      TEXT        NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status       TEXT        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at   TIMESTAMPTZ NOT NULL,
  finished_at  TIMESTAMPTZ,
  duration_ms  INTEGER,
  processed    INTEGER     NOT NULL DEFAULT 0,
  changed      INTEGER     NOT NULL DEFAULT 0,
  error        TEXT,
  details      JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS job_runs_one_running_idx ON job_runs (job_name, workspace_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS job_runs_started_idx ON job_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS job_runs_job_workspace_idx ON job_runs (job_name, workspace_id, started_at DESC);
