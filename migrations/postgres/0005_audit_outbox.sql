-- Transactional outbox for audit events (same table and approach as proba-audit's reference migration).
-- Rows are inserted in the memory service's own transaction, claimed by the relay with
-- FOR UPDATE SKIP LOCKED, and marked published after the bus accepted them.
CREATE TABLE IF NOT EXISTS audit_outbox (
  id           BIGSERIAL PRIMARY KEY,
  event_id     UUID        NOT NULL UNIQUE,
  payload      JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  last_error   TEXT,
  published_at TIMESTAMPTZ
);

-- The relay only reads unpublished rows, oldest first.
CREATE INDEX IF NOT EXISTS audit_outbox_pending_idx ON audit_outbox (id) WHERE published_at IS NULL;
-- Pruning reads published rows by age.
CREATE INDEX IF NOT EXISTS audit_outbox_published_idx ON audit_outbox (published_at) WHERE published_at IS NOT NULL;
