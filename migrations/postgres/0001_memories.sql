-- Memories: one self-contained statement per row, with its vector (pgvector, cosine) and a full-text column.
-- {{EMBEDDING_DIMENSION}} is replaced by the migrator with EMBEDDING_DIMENSION from the configuration.
-- Every statement is idempotent. Memories are never deleted: status moves active -> superseded | tombstoned.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memories (
  id                 UUID PRIMARY KEY,
  workspace_id       TEXT        NOT NULL,
  category           TEXT        NOT NULL CHECK (category IN ('working', 'episodic', 'semantic', 'procedural', 'super')),
  content            TEXT        NOT NULL,
  summary            TEXT,
  embedding          vector({{EMBEDDING_DIMENSION}}),
  embedding_model    TEXT,
  embedding_version  TEXT,
  importance         DOUBLE PRECISION NOT NULL CHECK (importance BETWEEN 0 AND 1),
  confidence         DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  usefulness         DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (usefulness BETWEEN 0 AND 1),
  status             TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'tombstoned')),
  supersedes_id      UUID REFERENCES memories (id),
  valid_from         TIMESTAMPTZ NOT NULL,
  valid_to           TIMESTAMPTZ,
  last_accessed_at   TIMESTAMPTZ,
  access_count       INTEGER     NOT NULL DEFAULT 0,
  last_reinforced_at TIMESTAMPTZ NOT NULL,
  decayed_at         TIMESTAMPTZ,
  evidence_count     INTEGER     NOT NULL DEFAULT 1,
  goal_id            TEXT,
  thread_id          TEXT,
  source_refs        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  provenance         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_tsv        tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(summary, '') || ' ' || content)) STORED
);

-- Every query is scoped by workspace first.
CREATE INDEX IF NOT EXISTS memories_workspace_status_category_idx ON memories (workspace_id, status, category);
CREATE INDEX IF NOT EXISTS memories_workspace_created_idx ON memories (workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS memories_workspace_goal_idx ON memories (workspace_id, goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_workspace_thread_idx ON memories (workspace_id, thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_decay_idx ON memories (workspace_id, category) WHERE status = 'active';
-- Full-text search.
CREATE INDEX IF NOT EXISTS memories_content_tsv_idx ON memories USING gin (content_tsv);
-- Approximate nearest neighbour search: HNSW on cosine distance.
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw_idx ON memories USING hnsw (embedding vector_cosine_ops);
