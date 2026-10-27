-- Speed up "retrievals that returned this memory" (JSONB containment on results[].id).
CREATE INDEX IF NOT EXISTS retrieval_log_results_gin ON retrieval_log USING gin (results jsonb_path_ops);
