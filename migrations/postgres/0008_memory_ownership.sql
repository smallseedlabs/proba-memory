-- Memory ownership: which user a memory was learned from, and who may read it through a user-scoped read.
--   owner_actor_id  the user (actor of the audit event) the memory belongs to. Nullable: a memory with no user behind it has no owner.
--   visibility      'owner'     only owner_actor_id may read it on a user-scoped read (a memory with no owner is then read by nobody there);
--                   'workspace' every user of the workspace may.
-- Administrator and viewer reads of the API are workspace-wide and do not look at either column.
-- Every statement is idempotent. Rollback: migrations/postgres/rollback/0008_memory_ownership.down.sql (documented, not applied automatically).
ALTER TABLE memories ADD COLUMN IF NOT EXISTS owner_actor_id TEXT;
-- Existing rows start as 'owner': nothing is shared unless it is explicitly marked 'workspace'.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'owner';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_visibility_check' AND conrelid = 'memories'::regclass) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_visibility_check CHECK (visibility IN ('owner', 'workspace'));
  END IF;
END $$;

-- Backfill from the evidence the memory was created from: the user who acted in the observation (an actor of type `user`), otherwise
-- the user the observation is about. A memory is given an owner only when ALL of its creating observations name the same single user;
-- one that mixes users, or that no user stands behind, keeps no owner (and so stays unreadable on user-scoped reads).
WITH evidence AS (
  SELECT s.memory_id,
         CASE
           WHEN o.actor ->> 'type' = 'user' AND COALESCE(o.actor ->> 'id', '') <> '' AND length(o.actor ->> 'id') <= 128 THEN o.actor ->> 'id'
           WHEN COALESCE(o.user_id, '') <> '' AND length(o.user_id) <= 128 THEN o.user_id
           ELSE NULL
         END AS owner
  FROM memory_sources s
  JOIN observations o ON o.id = s.observation_id AND o.workspace_id = s.workspace_id
  WHERE s.relation = 'created'
),
single_owner AS (
  SELECT memory_id, min(owner) AS owner
  FROM evidence
  GROUP BY memory_id
  HAVING count(*) = count(owner) AND count(DISTINCT owner) = 1
)
UPDATE memories m
SET owner_actor_id = single_owner.owner
FROM single_owner
WHERE m.id = single_owner.memory_id AND m.owner_actor_id IS NULL;

-- Scoped reads filter on (workspace_id, owner_actor_id) before ranking.
CREATE INDEX IF NOT EXISTS memories_workspace_owner_idx ON memories (workspace_id, owner_actor_id);
