-- Observations: what the write path was asked to learn from (redacted). The id is the idempotency key.
CREATE TABLE IF NOT EXISTS observations (
  id            UUID PRIMARY KEY,
  workspace_id  TEXT        NOT NULL,
  source        TEXT        NOT NULL,
  source_ref    TEXT        NOT NULL,
  kind          TEXT        NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  trace_id      TEXT,
  span_id       TEXT,
  goal_id       TEXT,
  thread_id     TEXT,
  user_id       TEXT,
  campaign_id   TEXT,
  actor         JSONB,
  target        JSONB,
  text          TEXT,
  facts         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  signal        JSONB       NOT NULL,
  significance  TEXT        NOT NULL CHECK (significance IN ('high', 'normal', 'low')),
  status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'skipped', 'failed')),
  attempts      INTEGER     NOT NULL DEFAULT 0,
  last_error    TEXT,
  processed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS observations_workspace_status_idx ON observations (workspace_id, status);
CREATE INDEX IF NOT EXISTS observations_workspace_occurred_idx ON observations (workspace_id, occurred_at DESC);

-- Which observations created or reinforced which memory.
CREATE TABLE IF NOT EXISTS memory_sources (
  workspace_id   TEXT        NOT NULL,
  memory_id      UUID        NOT NULL REFERENCES memories (id),
  observation_id UUID        NOT NULL REFERENCES observations (id),
  relation       TEXT        NOT NULL CHECK (relation IN ('created', 'reinforced')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, observation_id, relation)
);
CREATE INDEX IF NOT EXISTS memory_sources_observation_idx ON memory_sources (workspace_id, observation_id);

-- Relations between memories.
CREATE TABLE IF NOT EXISTS memory_links (
  workspace_id TEXT        NOT NULL,
  from_id      UUID        NOT NULL REFERENCES memories (id),
  to_id        UUID        NOT NULL REFERENCES memories (id),
  relation     TEXT        NOT NULL CHECK (relation IN ('supports', 'contradicts', 'supersedes')),
  weight       DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS memory_links_to_idx ON memory_links (workspace_id, to_id);
CREATE INDEX IF NOT EXISTS memory_links_from_idx ON memory_links (workspace_id, from_id);
