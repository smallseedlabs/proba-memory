-- Rolls back 0008_memory_ownership.sql. NOT applied by the migrator: run it by hand, then remove the row
-- (DELETE FROM schema_migrations WHERE version = '0008') so the migration can be applied again later.
-- The ownership data is dropped with the columns.
DROP INDEX IF EXISTS memories_workspace_owner_idx;
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_visibility_check;
ALTER TABLE memories DROP COLUMN IF EXISTS visibility;
ALTER TABLE memories DROP COLUMN IF EXISTS owner_actor_id;
