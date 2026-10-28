# proba-memory

The memory service of Proba: it learns from what happens (approvals, goals, conversations, audit and analytics
logs), stores that as typed memories in Postgres + pgvector, keeps them current in the background, and answers
"what do we know about this?" with scored, explainable results.

- **Categories:** working, episodic, semantic, procedural, super.
- **Write path:** source → observations → redaction → LLM extraction → resolver (merge / supersede / create) →
  embedding → store. Idempotent by observation id.
- **Read path:** vector + full-text + structured filters → rank fusion → configurable weighted score → MMR diversity
  → optional LLM rerank → token-budget packing. Every retrieval is logged and audited.
- **Jobs:** decay plus seven memory-lifecycle jobs (consolidate, promote, collapse, contradictions, re-embed,
  usage feedback, cleanup), each idempotent, leased, audited, with rules in a versioned database config.
- **Evaluation:** golden sets, ranking metrics, time-split backtest, profile comparison, a CI regression gate and
  shadow-profile analysis ([docs/EVALUATION.md](docs/EVALUATION.md)).
- **Separate from audit:** audit records what happened, memory is what was learned. Memory reads the audit stream
  and emits its own `memory.*` audit events.

Design, diagrams, ports and data model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
HTTP contract: [docs/openapi.yaml](docs/openapi.yaml). Behind a flag the API also serves a narrow, per-user service role for the context bridge: [docs/CONTEXT_READER.md](docs/CONTEXT_READER.md).

## Quickstart (everything local, no external provider)

Requirements: Node 20+, Docker.

```bash
npm ci
scripts/generate-local-env.sh   # writes .env with random Postgres and Redis passwords (nothing has a default password)
npm run docker:up               # Postgres+pgvector on 127.0.0.1:25432, Redis (ACL user, password) on 127.0.0.1:26379 (project proba-memory-dev)

set -a; source .env; set +a     # DATABASE_URL and REDIS_URL, with the generated passwords
export NODE_ENV=development EMBEDDER=hash LLM_PROVIDER=scripted \
       SOURCES=content HUB_CONTENT_SOURCE=dev LOG_LEVEL=warn

npm run migrate                 # create the schema (idempotent)
npm run seed                    # load 25 development items through the real write path
npm run search -- --limit=5 "what does the user think about discount banners with countdown timers"
npm run job -- decay            # run the decay job once
npm run job-config -- seed      # publish the default rules of the M2 jobs as version 1
npm run job -- cleanup --dry-run  # report what a job would change; writes nothing
```

`npm run search` prints every candidate with its features (vector and text rank, relevance, recency, importance,
confidence, usefulness), the weighted score, and why a candidate was dropped, then the final order. Add `--json`
for the full response.

The local setup uses a deterministic hash embedder and a rule-based extractor so it works offline. Their quality
is only good enough to exercise the flows: for real similarity and extraction configure `EMBEDDER=openai-compatible`
and `LLM_PROVIDER=deepseek` (see below).

Compose never starts without passwords (`${NAME:?set NAME}`), binds every published port to `127.0.0.1`, and runs Redis with an
ACL user instead of anonymous access. For a Redis outside the compose network use `rediss://<user>:<password>@host:6380` (TLS).

### Run the services

```bash
# the three services on the same containers, local settings, alternate host ports
MEMORY_API_HOST_PORT=23200 MEMORY_INGESTOR_HOST_PORT=23201 MEMORY_JOBS_HOST_PORT=23202 \
  docker compose -f docker-compose.yml -f docker-compose.local.yml --profile apps up -d --build

curl -s localhost:23200/ready
curl -s -H 'Authorization: Bearer local-dev-token' localhost:23200/v1/session
curl -s -H 'Authorization: Bearer local-dev-token' -H 'content-type: application/json' \
  -d '{"query":"countdown timers on banners","limit":3}' localhost:23200/v1/memories/search
```

`local-dev-token` exists only in `docker-compose.local.yml` (development mode) and the API refuses static
tokens in production. The workspace is taken from the deployment (`MEMORY_API_WORKSPACE_ID`), never from the request.

Watch it learn: publish an audit event with `content` (protocol 0.3.3) on the `proba.audit.events` stream, for
example a `thread.message_received` event with a user message; within a few seconds the ingestor stores it as a
redacted memory and it appears in `GET /v1/memories` and in search results.

### API

| Method and path | What |
| --- | --- |
| `GET /health`, `GET /ready` | liveness, readiness (no token) |
| `GET /v1/session` | who you are and which workspace you read |
| `POST /v1/memories/search` | hybrid retrieval, scores and trust marker; admins can ask for the candidate table |
| `GET /v1/memories`, `GET /v1/memories/{id}` | list with cursor, read one with its links |
| `GET /v1/profiles` | scoring profiles (full configuration for admins) |
| `GET /v1/retrievals/{id}` | one retrieval log entry (admins only; viewers get 403) |
| `GET /v1/memories/{id}/retrievals` | retrievals that returned this memory (admins only) |
| `GET /v1/jobs/runs` | job run history for the workspace (admins only; paginated) |

Read-only: there are no write routes. Retrieved text is untrusted data and carries `trust: "untrusted_data"`.
Admin retrieval and job-run reads are audited as `memory.retrieved`.
Production sign-in uses Firebase ID tokens (`MEMORY_API_TOKEN_VERIFIER=firebase`, `FIREBASE_PROJECT_ID`) with an
allow-list (`MEMORY_API_ALLOWED_EMAILS`, `MEMORY_API_ALLOWED_EMAIL_DOMAINS`, `MEMORY_API_ADMIN_EMAILS`).

## Background jobs

Eight jobs run on one framework (`JobRunner`): a lease per job and workspace (two runners never overlap), a `job_runs`
record, `system.job_run` / `system.job_failed` events, and structured logs with the trace id. Every job is
idempotent (running it twice gives the same result), never hard-deletes (memories move between `active`,
`superseded` and `tombstoned`), audits its changes with `memory.*` events whose details hold ids, counts and
scores (never memory text), and honours a dry-run mode that computes and reports but writes nothing.

| Job | What it does | Audit action |
| --- | --- | --- |
| `consolidate` | clusters episodic memories by vector similarity inside a time window, summarises each cluster into one semantic memory with the LLM (JSON mode, schema-checked), links the sources and supersedes them | `memory.consolidated` |
| `promote` | semantic to procedural, or to super, once count, confidence, age and approvals/rejections (the strongest preference signal) pass the thresholds | `memory.promoted` |
| `collapse` | merges memories that mean the same thing; raises confidence on reinforcement (new `supports`), lowers it on contradiction | `memory.collapsed`, `memory.confidence_adjusted` |
| `contradictions` | resolves opposite-stance pairs by recency, evidence strength and source; when the margin is too small both stay, linked `contradicts` | `memory.contradiction_resolved`, `memory.contradiction_linked` |
| `reembed` | moves every active memory to the configured embedder model and version in batches, with no downtime (staged vector, then atomic cutover) | `memory.reembedded` |
| `usage-feedback` | resolves each retrieval's outcome (approved, rejected, none) from the observations of its trace and moves the memories' learned `usefulness`, exactly once per retrieval | `memory.usage_updated` |
| `cleanup` | tombstones expired working memories and stale low-importance items | `memory.tombstoned` |
| `decay` | lowers confidence and importance over time (configured by `DECAY_*` env) | `memory.decayed` |

**Rules and thresholds live in the database, not in code.** The table `job_configs` holds immutable, versioned
JSON per (workspace, job); workspace `*` is the global version and a workspace with its own active version uses
that instead. The first run of a job (not a dry run) seeds the built-in defaults as version 1; publishing a new
version retires the previous one and keeps the history. Every run and audit event records the `configVersion` it used.

```bash
npm run job-config -- seed                                  # defaults as version 1 where none exists
npm run job-config -- show promote                          # the active version
npm run job-config -- history promote --workspace ws-123    # every version
npm run job-config -- publish promote promote.json --note "stricter super promotion"
```

Run a job once, for every workspace or one, with the same lease as the scheduled run:

```bash
npm run job -- consolidate --dry-run                # report only
npm run job -- reembed --workspace ws-123
```

Scheduling and defaults come from env (see `.env.example`): `JOBS_ENABLED` picks the jobs the process schedules,
`<JOB>_INTERVAL_MS` the cadence, `JOBS_DRY_RUN=true` makes every run a dry run, `JOBS_BATCH_SIZE` and
`JOBS_LLM_MAX_ATTEMPTS` bound the work. Changing the embedder model: see the re-embed rollout order in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#background-jobs).

## Evaluate retrieval changes

```bash
npm run build
# compare scoring profiles side by side on a golden set (the first profile is the baseline) -> JSON + Markdown
npm run eval -- run --golden=apps/memory-eval/golden/bundled.yaml --profile=default \
  --profile=apps/memory-eval/profiles/recency-heavy.yaml --out-dir=test-reports/compare
# time-split backtest: replay up to T, ask after T
npm run eval -- backtest --golden=apps/memory-eval/golden/bundled.yaml --split=2026-10-08T00:00:00Z
npm run eval:gate                  # CI gate: exits non-zero if a metric drops more than the tolerance below the baseline
npm run eval -- shadow --config apps/memory-eval/eval.config.yaml   # score a shadow profile from the retrieval log
```

Runs entirely in process (hash embedder, scripted LLM): no network, no model, no database. How to add golden cases
and how to read the report: [docs/EVALUATION.md](docs/EVALUATION.md).

## Configuration

Everything is configured through environment variables; `.env.example` lists them with safe defaults and
placeholders. Defaults: Postgres + pgvector store, Redis Streams bus, DeepSeek-compatible LLM through an
OpenAI-compatible endpoint, OpenAI-compatible embeddings (`EMBEDDER_BASE_URL`, `EMBEDDER_MODEL`,
`EMBEDDING_DIMENSION` must agree). Swapping any adapter is a config value plus a registered factory
([how](docs/ARCHITECTURE.md#swapping-an-adapter)).

Local stand-ins (`EMBEDDER=hash`, `LLM_PROVIDER=scripted`, `HUB_CONTENT_SOURCE=dev`, static tokens) refuse to
start in production unless explicitly allowed.

## Audit events

Memory emits audit events with the same emitter, transactional outbox, relay and Redis Streams publisher as
proba-audit (copied with identical interfaces: `createOutboxAuditEmitter`, `createBusAuditEmitter`,
`OutboxStore`, `OutboxRelay`, `EventBus`; `AUDIT_TRANSPORT=outbox|bus`). Actions: `memory.ingested`,
`memory.consolidated`, `memory.retrieved`, `memory.decayed`, `memory.promoted`, `memory.collapsed`,
`memory.confidence_adjusted`, `memory.contradiction_resolved`, `memory.contradiction_linked`, `memory.reembedded`,
`memory.usage_updated`, `memory.tombstoned`, plus `system.*` lifecycle events. Details hold ids,
counts and lengths, never memory text. Types come from `@smallseedlabs/proba-protocol` (pinned to v0.3.3).

Audit events with the optional admin-only `content` field are the primary source of conversation text;
`content` is treated as sensitive (redacted before any model or embedding call, never logged).

## Repository layout

```
packages/scoring     scoring profile schema and pure ranking functions
packages/core        domain, ports, write path, retrieval, audit emitter/outbox/relay, config, jobs framework
packages/adapters    Postgres, Redis Streams, embedder and LLM clients, sources, auth, in-process adapters
apps/memory-api      read API and operator search CLI
apps/memory-ingestor sources to write path, seed CLI
apps/memory-jobs     scheduler and runner, the eight jobs, versioned job config, run-job and job-config CLIs
apps/memory-eval     evaluation harness: golden sets, metrics, backtest, comparison, regression gate, shadow logs
migrations/postgres  numbered SQL migrations
docs                 ARCHITECTURE.md, EVALUATION.md, CONTEXT_READER.md, openapi.yaml, contracts/
```

## Development

```bash
npm run lint && npm run typecheck && npm run build
npm test                          # unit tests (in-process adapters)
npm run test:integration          # needs the Postgres and Redis from `npm run docker:up` and the .env URLs (see Quickstart)
npm run build && npm run eval:gate   # retrieval regression gate on the bundled golden set (no services needed)
```

CI runs lint, type-check and build, the unit tests, the compose security check (`node scripts/check-compose-security.mjs`:
fails when a published port is not on `127.0.0.1` or a password has a default), the retrieval regression gate, the integration tests on
the compose pgvector Postgres and authenticated Redis, and builds the four Docker images (`migrate`, `memory-api`, `memory-ingestor`, `memory-jobs`).
Docker host ports are deliberately uncommon (`POSTGRES_HOST_PORT`, `REDIS_HOST_PORT` and the `MEMORY_*_HOST_PORT`
variables override them).

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md). Licensed under Apache-2.0.

## Not built yet

Planned and prepared by extension points only: the portal screens (M4, including the screens on top of the
evaluation harness). The evaluation harness itself (M3 part A) and the M2 lifecycle jobs are built. The outcome
linker is an interface with a no-op default.

## Production safety

With `NODE_ENV=production` the services refuse to start (before creating any adapter) when an in-memory adapter is selected
(`InMemoryAdaptersNotAllowedError`; there is no opt-in, `ALLOW_IN_MEMORY_ADAPTERS=true` is refused too) or when `REDIS_URL`
has no password (`RedisPasswordRequiredError`). Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#production-guards).
