-- Scoring profiles: the tunable part of ranking, stored as versioned data. A version's config is
-- immutable; only status (rollout) changes. Workspace '*' holds the profiles every workspace falls back to.
CREATE TABLE IF NOT EXISTS scoring_profiles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  version        INTEGER     NOT NULL CHECK (version >= 1),
  status         TEXT        NOT NULL CHECK (status IN ('draft', 'shadow', 'canary', 'active', 'retired')),
  canary_percent INTEGER     NOT NULL DEFAULT 0 CHECK (canary_percent BETWEEN 0 AND 100),
  config         JSONB       NOT NULL,
  description    TEXT        NOT NULL DEFAULT '',
  created_by     TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name, version)
);
-- At most one active version per workspace and profile name.
CREATE UNIQUE INDEX IF NOT EXISTS scoring_profiles_one_active_idx ON scoring_profiles (workspace_id, name) WHERE status = 'active';
