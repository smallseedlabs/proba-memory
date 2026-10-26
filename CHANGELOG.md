# Changelog

All notable changes to proba-memory. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Evaluation harness (milestone 3, part A; `apps/memory-eval`, `docs/EVALUATION.md`): golden sets (YAML/JSON) with a
  loader and validation; recall@k, precision@k, nDCG@k, MRR, avoid rate, token-pack size and latency; time-split
  backtest (explicit splits or rolling windows); side-by-side comparison of scoring profiles with JSON and
  Markdown reports; a regression gate (`npm run eval:gate`, exit 1 on a drop beyond the tolerance, exit 3 on a
  stale baseline) wired into CI on a bundled golden set with the hash embedder and the scripted LLM; and a reader
  for shadow-profile logs (in process, from `retrieval_log`, or from an export). No portal screens (part B).
- CI job `Retrieval Regression Gate`; `npm run eval` and `npm run eval:gate`.

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
