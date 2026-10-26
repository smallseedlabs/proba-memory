# proba-memory

The memory service of Proba: it learns from what happens (approvals, goals, conversations, audit and analytics
logs), stores that as typed memories in Postgres + pgvector, keeps them current in the background, and answers
"what do we know about this?" with scored, explainable results.

- **Categories:** working, episodic, semantic, procedural, super.
- **Write path:** source → observations → redaction → LLM extraction → resolver (merge / supersede / create) →
  embedding → store. Idempotent by observation id.
- **Read path:** vector + full-text + structured filters → rank fusion → configurable weighted score → MMR diversity
  → optional LLM rerank → token-budget packing. Every retrieval is logged and audited.
- **Jobs:** decay today; the framework is ready for more.
- **Separate from audit:** audit records what happened, memory is what was learned. Memory reads the audit stream
  and emits its own `memory.*` audit events.

Design, diagrams, ports and data model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
HTTP contract: [docs/openapi.yaml](docs/openapi.yaml).

## Quickstart (everything local, no external provider)

Requirements: Node 20+, Docker.

```bash
npm ci
cp .env.example .env            # optional; the commands below set what they need
npm run docker:up               # Postgres+pgvector on 127.0.0.1:25432, Redis on 127.0.0.1:26379 (project proba-memory-dev)

export NODE_ENV=development DATABASE_URL=postgresql://proba:proba@localhost:25432/proba_memory \
       REDIS_URL=redis://localhost:26379 EMBEDDER=hash LLM_PROVIDER=scripted \
       SOURCES=content HUB_CONTENT_SOURCE=dev LOG_LEVEL=warn

npm run migrate                 # create the schema (idempotent)
npm run seed                    # load 25 development items through the real write path
npm run search -- --limit=5 "what does the user think about discount banners with countdown timers"
npm run job -- decay            # run the decay job once
```

`npm run search` prints every candidate with its features (vector and text rank, relevance, recency, importance,
confidence, usefulness), the weighted score, and why a candidate was dropped, then the final order. Add `--json`
for the full response.

The local setup uses a deterministic hash embedder and a rule-based extractor so it works offline. Their quality
is only good enough to exercise the flows: for real similarity and extraction configure `EMBEDDER=openai-compatible`
and `LLM_PROVIDER=deepseek` (see below).

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

Read-only: there are no write routes. Retrieved text is untrusted data and carries `trust: "untrusted_data"`.
Production sign-in uses Firebase ID tokens (`MEMORY_API_TOKEN_VERIFIER=firebase`, `FIREBASE_PROJECT_ID`) with an
allow-list (`MEMORY_API_ALLOWED_EMAILS`, `MEMORY_API_ALLOWED_EMAIL_DOMAINS`, `MEMORY_API_ADMIN_EMAILS`).

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
`memory.consolidated`, `memory.retrieved`, `memory.decayed`, plus `system.*` lifecycle events. Details hold ids,
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
apps/memory-jobs     scheduler and runner, decay job, run-job CLI
migrations/postgres  numbered SQL migrations
docs                 ARCHITECTURE.md, openapi.yaml
```

## Development

```bash
npm run lint && npm run typecheck && npm run build
npm test                          # unit tests (in-process adapters)
npm run test:integration          # needs the Postgres and Redis from `npm run docker:up`
```

CI runs lint, type-check and build, the unit tests, the integration tests on pgvector Postgres and Redis service
containers, and builds the four Docker images (`migrate`, `memory-api`, `memory-ingestor`, `memory-jobs`).
Docker host ports are deliberately uncommon (`POSTGRES_HOST_PORT`, `REDIS_HOST_PORT` and the `MEMORY_*_HOST_PORT`
variables override them).

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md). Licensed under Apache-2.0.

## Not built yet

Planned and prepared by extension points only: more background jobs (M2: consolidation, promotion to super,
contradiction resolution, re-embedding, usage feedback, cleanup), the evaluation harness (M3) and the portal
screens (M4). The outcome linker is an interface with a no-op default.
