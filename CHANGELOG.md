# Changelog

All notable changes to proba-memory. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Memory lifecycle jobs (milestone 2): `consolidate`, `promote`, `collapse`, `contradictions`, `reembed`,
  `usage-feedback` and `cleanup`, on the existing job framework. Each is idempotent, leased, audited with
  `memory.*` events (new: `memory.promoted`, `memory.collapsed`, `memory.confidence_adjusted`,
  `memory.contradiction_resolved`, `memory.contradiction_linked`, `memory.reembedded`, `memory.usage_updated`,
  `memory.tombstoned`) and supports a dry-run mode.
- Versioned job rules in the database (`job_configs`, ports `JobConfigStore` and `EmbeddingMigrationStore`,
  migration `0006_jobs_m2.sql`), with `npm run job-config` (seed, show, history, publish).
- `npm run job -- <name> [--dry-run] [--workspace <id>]`; env `JOBS_DRY_RUN`, `JOBS_BATCH_SIZE`,
  `JOBS_LLM_MAX_ATTEMPTS`, `<JOB>_INTERVAL_MS`, `JOB_CONFIG_STORE`, `EMBEDDING_MIGRATION_STORE`.
- Retrieval outcomes (`retrieval_log.outcome`) feeding the learned usefulness feature; zero-downtime re-embed
  through staged vectors and an atomic cutover.
- Contract suites for the new ports; unit and Postgres integration tests for every job.
- Memory lifecycle diagram in `docs/ARCHITECTURE.md`.

### Changed

- The job runner takes `dryRun` and `workspaceId` options; `decay` honours dry run and reports `changed: 0` then.

### Added (milestone 1)

- Memory service foundation (milestone 1): categories `working`, `episodic`, `semantic`, `procedural`, `super`,
  separate from the audit store, on Postgres + pgvector.
- Ports with swappable adapters chosen by config: memory store, vector index, scoring profiles, retrieval log,
  job runs, outbox, event bus (Redis Streams), embedder and LLM (OpenAI-compatible HTTP, DeepSeek preset),
  token counter, job scheduler, outcome linker (interface), source adapters, token verifier, rate limiter.
- Write path: audit and content sources, redaction, LLM extraction, resolver (merge, supersede, create), embedding,
  idempotent storage, provenance, `memory.ingested` and `memory.consolidated` audit events.
- Audit events with `content` (protocol 0.3.3) are the primary source of conversation text; the Hub content feed
  is a secondary source.
- Retrieval: vector + full-text + structured filters, reciprocal rank fusion, configurable weighted score, MMR,
  optional LLM rerank, token-budget packing, retrieval log, `memory.retrieved` audit events, versioned scoring
  profiles with shadow and canary rollout.
- Read API (`memory-api`) with Firebase sign-in, allow-list roles and OpenAPI contract (`docs/openapi.yaml`).
- Decay job with lease, per-category half-lives and `memory.decayed` events (`memory-jobs`).
- Operator tools: `npm run seed`, `npm run search`, `npm run job -- decay`; Docker images and compose files.
- Audit emitter, outbox and Redis publisher copied from proba-audit with identical interfaces.
