DROP INDEX IF EXISTS idx_memories_provenance_status_trust;

ALTER TABLE memories
  DROP COLUMN IF EXISTS evidence_campaign_id,
  DROP COLUMN IF EXISTS last_verified_at,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS trust,
  DROP COLUMN IF EXISTS source_kind;
