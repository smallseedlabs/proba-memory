-- H4-01: Knowledge provenance, trust decay, and approval status for own-outcome learning.
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'seed',
  ADD COLUMN IF NOT EXISTS trust DOUBLE PRECISION NOT NULL DEFAULT 0.6,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evidence_campaign_id TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_provenance_status_trust
  ON memories(status, source_kind, trust);
