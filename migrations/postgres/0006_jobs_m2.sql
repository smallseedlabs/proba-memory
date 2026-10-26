-- M2 background jobs: versioned job rules, a staged second vector for zero-downtime re-embedding, and the
-- outcome of every retrieval (for the usage-feedback job). Every statement is idempotent.

-- Rules and thresholds of the jobs as immutable, versioned data. Workspace '*' is the global default.
CREATE TABLE IF NOT EXISTS job_configs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT        NOT NULL,
  job_name     TEXT        NOT NULL,
  version      INTEGER     NOT NULL CHECK (version >= 1),
  status       TEXT        NOT NULL CHECK (status IN ('active', 'retired')),
  config       JSONB       NOT NULL,
  note         TEXT        NOT NULL DEFAULT '',
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, job_name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS job_configs_one_active_idx ON job_configs (workspace_id, job_name) WHERE status = 'active';

-- Re-embedding: the re-embed job writes the target model's vector here while `embedding` keeps serving; the
-- cutover swaps the two in one statement. Search never reads these columns, so retrieval has no downtime.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_next vector({{EMBEDDING_DIMENSION}});
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_next_model TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_next_version TEXT;
CREATE INDEX IF NOT EXISTS memories_embedding_model_idx ON memories (workspace_id, embedding_model, embedding_version) WHERE status = 'active';

-- Usage feedback: what became of a retrieval, and whether the usefulness update for it was applied.
ALTER TABLE retrieval_log ADD COLUMN IF NOT EXISTS outcome JSONB;
ALTER TABLE retrieval_log ADD COLUMN IF NOT EXISTS outcome_applied_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS retrieval_log_unresolved_idx ON retrieval_log (workspace_id, created_at) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS retrieval_log_unapplied_idx ON retrieval_log (workspace_id, created_at) WHERE outcome IS NOT NULL AND outcome_applied_at IS NULL;

-- Outcomes are resolved by trace id.
CREATE INDEX IF NOT EXISTS observations_workspace_trace_idx ON observations (workspace_id, trace_id) WHERE trace_id IS NOT NULL;
