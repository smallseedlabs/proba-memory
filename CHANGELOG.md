# Changelog

All notable changes to proba-memory. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
